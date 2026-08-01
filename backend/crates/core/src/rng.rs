//! Deterministic SplitMix64. Hand-rolled on purpose: the generator must produce
//! byte-identical data across machines and crate versions so frontend runs stay
//! comparable. A dependency that bumps its algorithm would silently invalidate
//! every recorded measurement.

#[derive(Clone)]
pub struct Rng(u64);

/// Strong 2-input mix. Avalanches both inputs so nearby `(seed, index)` pairs
/// land far apart in state space.
#[inline]
pub fn hash2(a: u64, b: u64) -> u64 {
    let mut x = a.wrapping_mul(0xD6E8_FEB8_6659_FD93).rotate_left(32)
        ^ b.wrapping_mul(0xA24B_AED4_963E_E407);
    x ^= x >> 32;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 29;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 32)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// Counter-based seeding: one independent stream per `(seed, index)` pair.
    ///
    /// SplitMix64 advances its state by a fixed constant γ, so two seeds differing
    /// by k·γ produce the *same* sequence shifted by k. Seeding chunks by XOR hit
    /// exactly that: two chunks landed 16γ apart and emitted byte-identical rows.
    /// Hashing the index into the seed removes the failure mode instead of making
    /// it rarer, and makes generation independent of chunk size.
    pub fn counter(seed: u64, index: u64) -> Self {
        Rng(hash2(seed, index))
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (Lemire multiply-shift; bias is negligible at these ranges).
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        (((self.next_u64() >> 32) * n as u64) >> 32) as u32
    }

    #[inline]
    pub fn f64_01(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
    }

    /// Skewed toward 0 — `power` > 1 makes low values dominate. Used so category
    /// and quantity distributions are non-uniform and filters return varied counts.
    #[inline]
    pub fn skewed_below(&mut self, n: u32, power: f64) -> u32 {
        let x = self.f64_01().powf(power);
        ((x * n as f64) as u32).min(n - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn deterministic_for_same_seed() {
        let a: Vec<u64> = (0..8).map(|_| Rng::new(42).next_u64()).collect();
        let b: Vec<u64> = (0..8).map(|_| Rng::new(42).next_u64()).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn below_stays_in_range() {
        let mut r = Rng::new(7);
        for _ in 0..10_000 {
            assert!(r.below(512) < 512);
        }
    }

    #[test]
    fn counter_streams_do_not_overlap() {
        // Regression: XOR-seeded chunks could differ by a multiple of SplitMix's
        // increment, making one stream a shifted copy of another. Take the first
        // few outputs of many streams and require every value to be distinct.
        let mut seen = std::collections::HashSet::new();
        for index in 0..4_000u64 {
            let mut r = Rng::counter(0xBEEF, index);
            for _ in 0..4 {
                assert!(seen.insert(r.next_u64()), "stream overlap at index {index}");
            }
        }
    }

    #[test]
    fn hash2_avalanches() {
        assert_ne!(super::hash2(1, 0), super::hash2(0, 1));
        assert_ne!(super::hash2(0xBEEF, 5), super::hash2(0xBEEF, 6));
    }
}
