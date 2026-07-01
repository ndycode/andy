//! Integer-safe percentage and ratio helpers.
//!
//! Budget and goal math previously used floats (`spent as f64 / limit`), which
//! risks rounding drift on values that are already exact integer centavos.
//! These helpers keep the arithmetic in `i64` with explicit rounding and
//! checked/saturating ops so money percentages never silently lose precision
//! or overflow.

/// Percentage of `numerator / denominator`, rounded half-up to the nearest
/// whole percent. Returns `None` when `denominator <= 0` (undefined). Uses
/// `i128` internally so large centavo values cannot overflow.
#[must_use]
pub fn percent_rounded(numerator: i64, denominator: i64) -> Option<i64> {
    if denominator <= 0 {
        return None;
    }
    let num = i128::from(numerator) * 100;
    let den = i128::from(denominator);
    // Round half away from zero.
    let rounded = if num >= 0 {
        (num + den / 2) / den
    } else {
        (num - den / 2) / den
    };
    // Narrow with a checked conversion: a percent that exceeds i64 (e.g.
    // i64::MAX / 1) must return None, not a sign-flipped wrap that would turn a
    // massive overspend into an apparent credit. Callers already handle None.
    i64::try_from(rounded).ok()
}

/// True when `numerator / denominator` reaches or exceeds `threshold_percent`,
/// computed without floats. `denominator <= 0` is treated as not-crossed.
#[must_use]
pub fn ratio_crossed(numerator: i64, denominator: i64, threshold_percent: i64) -> bool {
    if denominator <= 0 {
        return false;
    }
    // numerator/denominator >= threshold/100  <=>  numerator*100 >= threshold*denominator
    i128::from(numerator) * 100 >= i128::from(threshold_percent) * i128::from(denominator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_rounds_half_up() {
        assert_eq!(percent_rounded(8_000, 10_000), Some(80));
        assert_eq!(percent_rounded(1, 3), Some(33));
        assert_eq!(percent_rounded(2, 3), Some(67));
        assert_eq!(percent_rounded(0, 100), Some(0));
        assert_eq!(percent_rounded(100, 0), None);
    }

    #[test]
    fn percent_handles_large_centavos_without_overflow() {
        // 1 trillion centavos against a 2-trillion limit -> 50%, no overflow.
        assert_eq!(
            percent_rounded(1_000_000_000_000, 2_000_000_000_000),
            Some(50)
        );
    }

    #[test]
    fn ratio_crossed_matches_threshold() {
        assert!(ratio_crossed(8_000, 10_000, 80));
        assert!(!ratio_crossed(7_999, 10_000, 80));
        assert!(ratio_crossed(10_001, 10_000, 100));
        assert!(!ratio_crossed(5, 0, 80));
    }
}
