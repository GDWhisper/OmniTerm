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
///
/// Refresh-on-read is *not* a squeeze-out vector: an IP with no entry cannot be
/// refreshed at all (`is_blocked` never inserts), and an attacker who already
/// failed wants their entry **evicted** — eviction clears a failure count that
/// is about to block them. So keeping the most recently failing IP alive is the
/// correct direction, not the exploitable one.
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
/// and container networks.
///
/// Worst-case memory is MB-level, **measured** rather than estimated: on a live
/// instance one tracked IP costs about 200 B (key `String` + two `Instant`s +
/// the bounded `failures` vec + HashMap overhead), so a full table lands near
/// 0.8 MB. Measured by driving 2000 distinct loopback source IPs through
/// `/auth/login` on a throwaway instance and sampling `VmRSS` (linear tail:
/// 121 B/key; whole run: 200 B/key — VmRSS lags because the allocator reuses
/// freed pages, so treat these as an upper bound). This matches the structural
/// estimate for `HashMap<String, Entry>` (~100 B/entry: 24 B `String` header +
/// heap + 40 B `Entry` + bucket overhead), which is the tighter check.
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
    // Least-recently-*seen*: `last_seen` is refreshed on reads too, so "oldest"
    // means "least recently interesting", not "first ever inserted". Evicting by
    // key order or by iterator order would drop an arbitrary entry instead.
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
        // A moment in the *past*, so synthetic stamps derived from it stay
        // older than any real `Instant::now()` the guard takes later (the
        // newcomer carries a natural `now` until the restamp below).
        let base = Instant::now() - Duration::from_secs(10);
        let g = LoginGuard::new();

        // Fill *to* the cap: keys `…0000`..`…4095`, equal digit width so
        // lexicographic order equals numeric order — a key-ordered eviction
        // would drop `…0000`, which this policy must protect.
        for i in 0..MAX_TRACKED_IPS {
            g.record_failure(&format!("10.0.0.{:04}", i));
        }

        /// Restamp every entry so that recency is a strict function of the key's
        /// numeric tail, with `…0000` and `…9999` pushed far into the future.
        ///
        /// Stamping must be by key value, never by `enumerate()`: a HashMap
        /// iterates in seed-dependent order, so an `enumerate()` ladder hands the
        /// floor to whichever entry the iteration happens to visit first — the
        /// very entry a `map.keys().next()` eviction also picks, which made the
        /// test blind to that mutation (it survived an earlier run).
        ///
        /// `…9999` is restamped too: `record_failure` stamps its own entry with
        /// a real `now`, which is *older* than every synthetic stamp and would
        /// therefore make the newcomer the eviction victim by accident.
        fn restamp(g: &LoginGuard, base: Instant) {
            let mut map = g.inner.lock().unwrap();
            for (k, entry) in map.iter_mut() {
                let n: u64 =
                    k.rsplit('.').next().and_then(|t| t.parse().ok()).expect("fill key parses");
                entry.last_seen = match k.as_str() {
                    // Protected by intent: neither an LRU nor a key-ordered
                    // policy may drop these two.
                    "10.0.0.0000" | "10.0.0.9999" => base + Duration::from_secs(3600),
                    // All remaining keys stay strictly older than the newcomer's
                    // natural `now`, and `…0001` is the oldest of them all.
                    _ => base + Duration::from_millis(n),
                };
            }
        }

        restamp(&g, base);

        let floor = {
            let map = g.inner.lock().unwrap();
            map.values().map(|e| e.last_seen).min().unwrap()
        };
        let keys_before: std::collections::HashSet<String> = {
            let map = g.inner.lock().unwrap();
            map.keys().cloned().collect()
        };

        g.record_failure("10.0.0.9999"); // one over the cap
        restamp(&g, base); // keep the newcomer's synthetic stamp (see above)

        let map = g.inner.lock().unwrap();
        assert_eq!(map.len(), MAX_TRACKED_IPS, "cap must be re-established exactly");
        assert!(map.contains_key("10.0.0.0000"), "protected IP was evicted");
        assert!(map.contains_key("10.0.0.9999"), "the newly inserted IP must survive");

        let gone: Vec<&String> =
            keys_before.iter().filter(|k| !map.contains_key(k.as_str())).collect();
        assert_eq!(gone.len(), 1, "exactly one entry may be evicted; gone={gone:?}");

        // If the survivor holding the oldest recency is newer than the floor
        // measured before the overflow, then the entry that left was the floor
        // entry — i.e. eviction is LRU and not key-ordered, insertion-ordered,
        // iteration-ordered or random. A candidate-list approach cannot make
        // this check: it is blind to an eviction that hit some *other* entry,
        // which is exactly what a wrong policy does.
        let min_surviving = map.values().map(|e| e.last_seen).min().unwrap();
        assert!(
            min_surviving > floor,
            "the evicted entry must have been the least recently seen one: \
             surviving minimum {min_surviving:?} should be newer than floor {floor:?}"
        );
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
