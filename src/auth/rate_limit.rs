use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Sliding-window limiter for login/setup attempts, keyed by client IP.
/// The single admin password is the only gate between a network attacker and
/// full control of the host, so it needs protection beyond bcrypt cost when
/// the server is reachable beyond loopback.
#[derive(Clone)]
pub struct LoginGuard {
    inner: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

/// Failed attempts allowed within [`WINDOW`] before the client is blocked.
const MAX_FAILURES: usize = 5;
/// Length of the sliding window for failure counting.
const WINDOW: Duration = Duration::from_secs(300);

impl LoginGuard {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// `true` when the client already exceeded the failure budget —
    /// callers should reject with 429 *without* running the bcrypt check.
    pub fn is_blocked(&self, ip: &str) -> bool {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        let hits = map.entry(ip.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < WINDOW);
        hits.len() >= MAX_FAILURES
    }

    /// Record one failed attempt.
    pub fn record_failure(&self, ip: &str) {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        let hits = map.entry(ip.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < WINDOW);
        hits.push(now);
    }

    /// Clear the failure history after a successful login.
    pub fn record_success(&self, ip: &str) {
        self.inner.lock().unwrap().remove(ip);
    }
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
            let hits = map.get_mut("1.2.3.4").unwrap();
            for t in hits.iter_mut() {
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
}
