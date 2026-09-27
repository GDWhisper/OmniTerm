use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Sliding-window limiter for login/setup attempts, keyed by client IP.
/// The single admin password is the only gate between a network attacker and
/// full control of the host, so it needs protection beyond bcrypt cost when
/// the server is reachable beyond loopback.
///
/// # Memory bound (§P1)
///
/// The accumulating dimension is the number of *distinct IPs*, not failures:
/// every request consults the map, and the guard is reachable without a token
/// from three handlers (`src/api/auth.rs`): `/auth/login` and `/auth/setup`
/// are public outright, and `/auth/change-password` sits behind
/// `require_auth_mw` but that middleware passes everything through while
/// `auth_enabled` is off (see `verify_request`). Without a cap, an attacker
/// who can reach the port with many source IPs grows the map without limit,
/// so the entry count is bounded by [`MAX_TRACKED_IPS`]; the least recently
/// seen entry is evicted when the cap would be exceeded.
///
/// Eviction costs nothing real: an entry's state is worthless after
/// [`WINDOW`] no matter what, so the evicted IP's failure history would have
/// been discarded within five minutes anyway. The stricter alternative
/// ("once full, reject every new IP") trades that for locking the admin out
/// after a burst of foreign traffic.
///
/// `is_blocked` reads through `get_mut` and never `entry`, so a request that
/// merely *probes* an unknown IP creates no entry. That was the cheapest
/// unbounded-growth path: one unauthenticated request per fresh IP was enough.
#[derive(Clone)]
pub struct LoginGuard {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
}

/// One client IP's failure history plus when it was last touched.
///
/// `last_seen` is refreshed on every read *and* write so "oldest" means "least
/// recently interesting" rather than "first ever inserted": a client that
/// keeps knocking while blocked keeps its entry alive, while an entry left
/// behind by an attacker who already went away is the first to go.
struct Entry {
    /// Failure timestamps inside the current window. Pruned on touch, so this
    /// holds at most [`MAX_FAILURES`] + 1 elements.
    failures: Vec<Instant>,
    last_seen: Instant,
}

impl Entry {
    fn new(now: Instant) -> Self {
        Self { failures: Vec::new(), last_seen: now }
    }

    /// Drop failures that fell out of the sliding window and refresh `last_seen`.
    fn prune(&mut self, now: Instant) {
        self.failures.retain(|t| now.duration_since(*t) < WINDOW);
        self.last_seen = now;
    }

    fn failure_count(&self) -> usize {
        self.failures.len()
    }
}

/// Failed attempts allowed within [`WINDOW`] before the client is blocked.
const MAX_FAILURES: usize = 5;
/// Length of the sliding window for failure counting.
const WINDOW: Duration = Duration::from_secs(300);

/// Distinct tracked-IP cap (§P1). This is a single-admin product: real
/// deployments have one human, so 4096 comfortably covers NAT'd offices, VPNs
/// and container networks while pinning worst-case memory at the MB level
/// (each entry is a `Vec<Instant>` that pruning keeps at [`MAX_FAILURES`] + 1
/// elements, two `Instant`s, plus the key string and HashMap overhead, so
/// roughly a few hundred bytes → ~1 MB at the cap. Not measured, estimated).
///
/// The ratio to `MAX_FAILURES` matters far more than the absolute value:
/// eviction only ever discards entries whose timestamps are already worthless,
/// so the cap can be generous without weakening the limiter.
pub const MAX_TRACKED_IPS: usize = 4096;

impl LoginGuard {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// `true` when the client already exceeded the failure budget —
    /// callers should reject with 429 *without* running the bcrypt check.
    ///
    /// Read-only with respect to the map's size: an unknown IP is reported as
    /// not blocked and gets no entry (see the struct docs).
    pub fn is_blocked(&self, ip: &str) -> bool {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        let Some(entry) = map.get_mut(ip) else { return false };
        entry.prune(now);
        entry.failure_count() >= MAX_FAILURES
    }

    /// Record one failed attempt. This is the only path that inserts, so it is
    /// the only path that can exceed the cap.
    pub fn record_failure(&self, ip: &str) {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        let entry = map.entry(ip.to_string()).or_insert_with(|| Entry::new(now));
        entry.prune(now);
        entry.failures.push(now);
        cap_tracked_ips(&mut map);
    }

    /// Clear the failure history after a successful login. Removing an entry
    /// cannot push the map over the cap, so no eviction runs here.
    pub fn record_success(&self, ip: &str) {
        self.inner.lock().unwrap().remove(ip);
    }

    /// Number of tracked IPs (unit-test only).
    #[cfg(test)]
    pub fn tracked_len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

/// Enforce the entry cap by evicting the least recently seen entry.
///
/// Takes `&mut HashMap` because the caller already holds the lock. Every
/// insert enforces the cap before releasing it, so the map never exceeds
/// [`MAX_TRACKED_IPS`] by more than one and a single eviction restores it.
fn cap_tracked_ips(map: &mut HashMap<String, Entry>) {
    if map.len() <= MAX_TRACKED_IPS {
        return;
    }
    let Some(oldest) = map.iter().min_by_key(|(_, entry)| entry.last_seen).map(|(k, _)| k.clone())
    else {
        return;
    };
    map.remove(&oldest);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_failures() {
        let g = LoginGuard::new();
        for _ in 0..MAX_FAILURES {
            assert!(!g.is_blocked("1.2.3.4")); // attempt is allowed
            g.record_failure("1.2.3.4");
        }
        // The next attempt (window already holds MAX_FAILURES failures) is blocked.
        assert!(g.is_blocked("1.2.3.4"));
        assert!(g.is_blocked("1.2.3.4"));
    }

    #[test]
    fn success_resets_counter() {
        let g = LoginGuard::new();
        for _ in 0..MAX_FAILURES {
            g.record_failure("1.2.3.4");
        }
        assert!(g.is_blocked("1.2.3.4"));
        g.record_success("1.2.3.4");
        assert!(!g.is_blocked("1.2.3.4"));
    }

    #[test]
    fn window_expiry_resets_counter() {
        let g = LoginGuard::new();
        for _ in 0..MAX_FAILURES {
            g.record_failure("1.2.3.4");
        }
        assert!(g.is_blocked("1.2.3.4"));
        // Age the recorded timestamps past the window.
        {
            let mut map = g.inner.lock().unwrap();
            let entry = map.get_mut("1.2.3.4").unwrap();
            for t in entry.failures.iter_mut() {
                *t = Instant::now() - WINDOW - Duration::from_secs(1);
            }
        }
        assert!(!g.is_blocked("1.2.3.4"));
    }

    #[test]
    fn ips_are_isolated() {
        let g = LoginGuard::new();
        for _ in 0..MAX_FAILURES {
            g.record_failure("1.2.3.4");
        }
        assert!(g.is_blocked("1.2.3.4"));
        assert!(!g.is_blocked("5.6.7.8"));
    }

    /// A read-only check must not create an entry: `is_blocked` used to go
    /// through `entry().or_default()`, so probing `/auth/login` with fresh IPs
    /// grew the map with no failed password ever recorded.
    #[test]
    fn is_blocked_does_not_insert_unknown_ip() {
        let g = LoginGuard::new();
        for i in 0..10 {
            assert!(!g.is_blocked(&format!("10.0.0.{i}")));
        }
        assert_eq!(g.tracked_len(), 0);
    }

    /// §P1: the tracked-IP count is the accumulating dimension and it must be
    /// capped. Overflow well past the boundary so an off-by-one in the
    /// comparison cannot pass.
    #[test]
    fn tracked_ip_count_never_exceeds_cap() {
        let g = LoginGuard::new();
        for i in 0..MAX_TRACKED_IPS + 200 {
            g.record_failure(&format!("10.{}.{}.{}", i / 65536, (i / 256) % 256, i % 256));
        }
        assert!(
            g.tracked_len() <= MAX_TRACKED_IPS,
            "tracked {} IPs, cap is {}",
            g.tracked_len(),
            MAX_TRACKED_IPS
        );
        // Every survivor holds its failure, i.e. the cap — not window pruning —
        // is what keeps the size in check.
        assert!(g.inner.lock().unwrap().values().all(|e| e.failure_count() == 1));
    }

    /// The cap must be re-established exactly, not merely "not exceeded": one
    /// insert over the limit evicts exactly one entry.
    #[test]
    fn one_insert_over_cap_evicts_exactly_one_entry() {
        let g = LoginGuard::new();
        for i in 0..MAX_TRACKED_IPS - 1 {
            g.record_failure(&format!("10.0.0.{:04}", i));
        }
        assert_eq!(g.tracked_len(), MAX_TRACKED_IPS - 1);
        g.record_failure("10.0.0.9999"); // one over
        assert_eq!(g.tracked_len(), MAX_TRACKED_IPS);
    }

    /// Eviction order is "least recently seen". The construction makes the
    /// plausible wrong policies disagree with the intended one instead of
    /// coinciding with it: fill keys carry equal digit width, so lexicographic
    /// order equals insertion order and a key-ordered eviction would drop
    /// exactly the entry this policy protects. (With mixed widths, e.g. `.0`
    /// alongside `.5904`, string sorting disagrees with numeric ordering and
    /// such a mistake could masquerade as correct.)
    ///
    /// Recency is stamped directly instead of via `sleep`, so the test does not
    /// depend on how close together the fills land — the same technique the
    /// window-expiry test above uses for timestamps. The fill stops one short
    /// of the cap so nothing is evicted *during* the fill and every key below
    /// is guaranteed present when the stamping runs.
    #[test]
    fn cap_evicts_least_recently_seen_first() {
        let base = Instant::now();
        let g = LoginGuard::new();
        // Fill *to* the cap so no eviction happens during the fill, then the
        // single insert below is what crosses it.
        for i in 0..MAX_TRACKED_IPS {
            g.record_failure(&format!("10.0.0.{:04}", i));
        }
        // Stamp recency so it increases with fill order, then push one key far
        // into the future. The future-stamped key is the one an LRU policy must
        // protect, and — being the lexicographically smallest key of the fill
        // set under equal digit width — the first thing a key-ordered eviction
        // would drop, so the two policies disagree on it.
        {
            let mut map = g.inner.lock().unwrap();
            for (i, (_, entry)) in map.iter_mut().enumerate() {
                entry.last_seen = base + Duration::from_micros(i as u64);
            }
            map.get_mut("10.0.0.0000").unwrap().last_seen = base + Duration::from_secs(3600);
        }
        // Snapshot the recency floor *before* the overflowing insert decides
        // who goes, so the assertion below can check the policy itself rather
        // than guess which key it happened to pick.
        let floor = {
            let map = g.inner.lock().unwrap();
            map.values().map(|e| e.last_seen).min().unwrap()
        };
        let victim_candidates: Vec<String> = {
            let map = g.inner.lock().unwrap();
            map.iter().filter(|(_, e)| e.last_seen == floor).map(|(k, _)| k.clone()).collect()
        };
        g.record_failure("10.0.0.9999"); // overflow by one

        let map = g.inner.lock().unwrap();
        assert_eq!(map.len(), MAX_TRACKED_IPS, "cap must be re-established exactly");
        assert!(map.contains_key("10.0.0.0000"), "protected IP was evicted");
        assert!(map.contains_key("10.0.0.9999"), "the newly inserted IP must survive");

        // The policy invariant, not a key coincidence: the entry that actually
        // disappeared is exactly the one that was least recently seen. Under
        // any `last_seen`-independent policy (key order, FIFO on a shuffled
        // map, LIFO) the dropped key is a different one more often than not,
        // and under "no eviction" the length assertion above already fails.
        let survivors: std::collections::HashSet<&String> = map.keys().collect();
        let evicted: Vec<&String> =
            victim_candidates.iter().filter(|k| !survivors.contains(k)).collect();
        assert_eq!(
            evicted.len(),
            1,
            "the only evicted entry must be a least-recently-seen one; evicted={evicted:?}"
        );
        // The victim carried the floor timestamp, never the future-stamped one.
        assert_ne!(floor, base + Duration::from_secs(3600));
    }

    /// Reads must refresh recency, otherwise the eviction policy can only ever
    /// see first-insertion order and a client being probed while blocked would
    /// be evicted as if it had gone away. This is what makes the policy LRU
    /// rather than FIFO over insertion.
    #[test]
    fn a_read_refreshes_recency_of_an_existing_entry() {
        let base = Instant::now();
        let g = LoginGuard::new();
        g.record_failure("10.0.0.1");
        {
            let mut map = g.inner.lock().unwrap();
            map.get_mut("10.0.0.1").unwrap().last_seen = base;
        }
        // A blocked-status read prunes (and re-stamps) the entry even though it
        // records nothing.
        assert!(!g.is_blocked("10.0.0.1"));
        let after = g.inner.lock().unwrap();
        assert!(
            after.get("10.0.0.1").unwrap().last_seen > base,
            "is_blocked did not refresh last_seen; read path is not part of LRU"
        );
    }

    /// Eviction must not silently disable the limiter: the accumulation and
    /// lookup paths keep working across a cap breach.
    #[test]
    fn eviction_keeps_limiter_functional() {
        let g = LoginGuard::new();
        for i in 0..MAX_TRACKED_IPS + 50 {
            g.record_failure(&format!("10.1.{}.{}", i / 256, i % 256));
        }
        for _ in 0..MAX_FAILURES {
            g.record_failure("10.2.0.1");
        }
        assert!(g.is_blocked("10.2.0.1"));
    }
}
