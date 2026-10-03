//! Reconnect delays: exponential growth with jitter, capped.

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::time::Duration;

/// The first reconnect waits about this long.
pub const DEFAULT_BASE: Duration = Duration::from_secs(1);
/// No reconnect waits longer than this.
pub const DEFAULT_MAX: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Self {
            base: base.min(max),
            max,
            attempt: 0,
        }
    }

    /// Takes the server's `retry:` hint as the base delay. The floor keeps a
    /// hint of zero from turning reconnects into a busy loop.
    pub fn set_base(&mut self, hint: Duration, floor: Duration) {
        self.base = hint.max(floor).min(self.max);
    }

    /// The delay before the next attempt. The cap doubles from the base on
    /// every attempt up to the maximum; `pick(span)` must return a number in
    /// `0..=span` and places the delay between half the cap and the cap
    /// ("equal jitter"), so clients that dropped together do not return
    /// together.
    pub fn next_delay(&mut self, pick: impl FnOnce(u64) -> u64) -> Duration {
        let factor = 2u32.saturating_pow(self.attempt);
        let cap = self.base.saturating_mul(factor).min(self.max);
        self.attempt = self.attempt.saturating_add(1);
        let cap_ms = u64::try_from(cap.as_millis()).unwrap_or(u64::MAX);
        let half = cap_ms / 2;
        let span = cap_ms - half;
        Duration::from_millis(half + pick(span).min(span))
    }

    /// Starts over from the base after a healthy connection.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// A uniformly random number in `0..=span` for [`Backoff::next_delay`].
/// Jitter needs no cryptographic quality, so the standard library's randomly
/// seeded hasher is enough.
pub fn random_pick(span: u64) -> u64 {
    let random = RandomState::new().hash_one(std::time::SystemTime::now());
    random % span.saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn doubles_up_to_the_cap_without_jitter_at_the_top() {
        let mut backoff = Backoff::new(secs(1), secs(300));
        let delays: Vec<Duration> = (0..11).map(|_| backoff.next_delay(|span| span)).collect();
        assert_eq!(
            delays,
            [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]
                .map(secs)
                .to_vec()
        );
    }

    #[test]
    fn jitter_keeps_the_delay_between_half_the_cap_and_the_cap() {
        let mut low = Backoff::new(secs(1), secs(300));
        let mut high = low.clone();
        for _ in 0..12 {
            let floor = low.next_delay(|_| 0);
            let ceiling = high.next_delay(|span| span);
            assert_eq!(floor, ceiling / 2);
        }
        assert_eq!(low.next_delay(|_| 0), secs(150));
    }

    #[test]
    fn a_pick_beyond_the_span_is_clamped() {
        let mut backoff = Backoff::new(secs(4), secs(300));
        assert_eq!(backoff.next_delay(|_| u64::MAX), secs(4));
    }

    #[test]
    fn never_exceeds_five_minutes_with_default_limits() {
        let mut backoff = Backoff::new(DEFAULT_BASE, DEFAULT_MAX);
        for _ in 0..200 {
            assert!(backoff.next_delay(random_pick) <= DEFAULT_MAX);
        }
        assert_eq!(backoff.next_delay(|span| span), DEFAULT_MAX);
    }

    #[test]
    fn reset_starts_over_from_the_base() {
        let mut backoff = Backoff::new(secs(2), secs(300));
        backoff.next_delay(|span| span);
        backoff.next_delay(|span| span);
        backoff.reset();
        assert_eq!(backoff.next_delay(|span| span), secs(2));
    }

    #[test]
    fn server_retry_hint_sets_the_base_within_bounds() {
        let mut backoff = Backoff::new(secs(1), secs(300));
        backoff.set_base(secs(10), secs(1));
        assert_eq!(backoff.next_delay(|span| span), secs(10));

        backoff.reset();
        backoff.set_base(Duration::ZERO, secs(1));
        assert_eq!(backoff.next_delay(|span| span), secs(1));

        backoff.reset();
        backoff.set_base(secs(3600), secs(1));
        assert_eq!(backoff.next_delay(|span| span), secs(300));
    }

    #[test]
    fn random_pick_stays_in_range() {
        for span in [0, 1, 7, 1000] {
            for _ in 0..50 {
                assert!(random_pick(span) <= span);
            }
        }
    }
}
