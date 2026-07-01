//! Property-based stress tests for the pure domain surfaces.
//!
//! `proptest` throws thousands of random (including adversarial and extreme)
//! inputs at these functions to lock four invariant classes the hand-written
//! tests can't cover exhaustively:
//!   1. money round-trips (format_php ∘ parse_amount is identity on legal range)
//!   2. totality — never panics on ANY input (i64/string/date extremes)
//!   3. exact arithmetic bounds (percent_rounded matches i128 truth or None)
//!   4. ordering/consistency of analytics outputs
//!
//! Each was chosen to fail on a specific bug the stress-test pass found, so the
//! fixes stay locked.

use andy_shared::analytics::{project_month_end_robust, spending_delta};
use andy_shared::date_validation::validate_calendar_date;
use andy_shared::dedup::content_dedup_key;
use andy_shared::money::{MAX_ENTRY_CENTAVOS, format_php, parse_amount};
use andy_shared::percent::{percent_rounded, ratio_crossed};
use andy_shared::security::constant_time_equal;
use andy_shared::time::{local_date, month_bounds};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use proptest::prelude::*;

proptest! {
    // ---- Class 2: totality (never panics) ----

    /// parse_amount must return (Ok or Err) for ANY string — never panic. This
    /// is the unauthenticated webhook surface; the rust_decimal overflow bug
    /// made large numeric input panic.
    #[test]
    fn parse_amount_never_panics(s in ".*") {
        let _ = parse_amount(&s);
    }

    /// parse_amount over pathological numeric-ish strings (long digit runs,
    /// suffixes, separators) still never panics.
    #[test]
    fn parse_amount_numeric_shapes_never_panic(
        s in "[0-9]{0,40}[.,]?[0-9]{0,40}[km]?"
    ) {
        let _ = parse_amount(&s);
    }

    /// format_php must never panic for ANY i64 — including i64::MIN, where the
    /// old abs() overflowed.
    #[test]
    fn format_php_never_panics(centavos in any::<i64>()) {
        let out = format_php(centavos);
        prop_assert!(out.contains('₱'));
        // Sign marker is present iff negative.
        prop_assert_eq!(out.starts_with('-'), centavos < 0);
    }

    /// percent_rounded never panics and never returns a wrapped value: it is
    /// Some(exact i64) or None (undefined / unrepresentable).
    #[test]
    fn percent_rounded_never_panics(num in any::<i64>(), den in any::<i64>()) {
        let _ = percent_rounded(num, den);
    }

    /// ratio_crossed never panics for any inputs.
    #[test]
    fn ratio_crossed_never_panics(
        num in any::<i64>(),
        den in any::<i64>(),
        pct in any::<i64>(),
    ) {
        let _ = ratio_crossed(num, den, pct);
    }

    /// spending_delta never panics (old raw subtraction overflowed).
    #[test]
    fn spending_delta_never_panics(a in any::<i64>(), b in any::<i64>()) {
        let cmp = spending_delta(a, b);
        // delta is the saturating difference; direction agrees with its sign.
        prop_assert_eq!(cmp.delta, a.saturating_sub(b));
    }

    /// project_month_end_robust never panics for any amount vector / day inputs
    /// (old i64 sum + median-add + projection-add all overflowed).
    #[test]
    fn project_month_end_robust_never_panics(
        amounts in prop::collection::vec(any::<i64>(), 0..12),
        dom in any::<i64>(),
        dim in any::<i64>(),
    ) {
        let _ = project_month_end_robust(&amounts, dom, dim);
    }

    /// content_dedup_key never panics and always yields the ch_ + 32-hex shape,
    /// for arbitrary (including control-char) phone/text.
    #[test]
    fn content_dedup_key_shape_holds(phone in ".*", text in ".*", secs in any::<i64>()) {
        let at = DateTime::<Utc>::from_timestamp(secs.rem_euclid(4_000_000_000), 0)
            .unwrap_or_else(Utc::now);
        let key = content_dedup_key(&phone, &text, at);
        prop_assert!(key.starts_with("ch_"));
        prop_assert_eq!(key.len(), 3 + 32);
    }

    /// constant_time_equal never panics and matches logical string equality for
    /// arbitrary inputs (the security property is timing; correctness is here).
    #[test]
    fn constant_time_equal_matches_eq(a in ".*", b in ".*") {
        prop_assert_eq!(constant_time_equal(&a, &b), a == b);
    }

    /// validate_calendar_date never panics for any input.
    #[test]
    fn validate_calendar_date_never_panics(s in ".*") {
        let _ = validate_calendar_date(&s);
    }

    /// month_bounds never panics for ANY NaiveDate (old December branch panicked
    /// at chrono's max year), and always returns first <= last within the same
    /// month as `first`.
    #[test]
    fn month_bounds_total_and_ordered(days in any::<i32>()) {
        let base = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
        let Some(date) = base.checked_add_signed(chrono::Duration::days(i64::from(days))) else {
            return Ok(());
        };
        let (first, last) = month_bounds(date);
        prop_assert!(first <= last);
        prop_assert_eq!(first.day(), 1);
    }

    /// local_date never panics for any timestamp + any offset in the legal band.
    #[test]
    fn local_date_never_panics(secs in any::<i64>(), offset in -840i32..=840) {
        let at = DateTime::<Utc>::from_timestamp(secs.rem_euclid(8_000_000_000), 0)
            .unwrap_or_else(Utc::now);
        let _ = local_date(at, offset);
    }
}

/// Independent i128 reference for percent_rounded's half-away-from-zero result.
fn percent_ref(num: i64, den: i64) -> Option<i64> {
    if den <= 0 {
        return None;
    }
    let n = i128::from(num) * 100;
    let d = i128::from(den);
    let rounded = if n >= 0 {
        (n + d / 2) / d
    } else {
        (n - d / 2) / d
    };
    i64::try_from(rounded).ok()
}

proptest! {
    // ---- Class 3: exact arithmetic (percent matches i128 truth or None) ----

    /// percent_rounded equals the i128-computed truth, or None when that truth
    /// doesn't fit i64 — never a silently wrapped value.
    #[test]
    fn percent_rounded_matches_i128_truth(num in any::<i64>(), den in any::<i64>()) {
        prop_assert_eq!(percent_rounded(num, den), percent_ref(num, den));
    }

    /// ratio_crossed agrees with the exact i128 comparison for positive
    /// denominators, and is false for non-positive ones.
    #[test]
    fn ratio_crossed_matches_i128(num in any::<i64>(), den in any::<i64>(), pct in any::<i64>()) {
        let expected = den > 0
            && i128::from(num) * 100 >= i128::from(pct) * i128::from(den);
        prop_assert_eq!(ratio_crossed(num, den, pct), expected);
    }

    // ---- Class 1: money round-trip ----

    /// For any legal centavo amount, parse_amount(format_php(x)) recovers x.
    /// format_php renders "₱P.CC" with thousands separators; parse_amount reads
    /// it back. Only positive amounts within the per-entry cap are legal inputs
    /// to parse (it rejects <= 0 and > cap), so restrict the strategy to that
    /// domain — the exact contract the app relies on.
    #[test]
    fn money_round_trips_over_legal_range(centavos in 1i64..=MAX_ENTRY_CENTAVOS) {
        let rendered = format_php(centavos);
        let parsed = parse_amount(&rendered);
        prop_assert_eq!(parsed, Ok(centavos), "round-trip failed for {}", rendered);
    }

    /// format_php always renders exactly two centavo digits.
    #[test]
    fn format_php_has_two_centavo_digits(centavos in any::<i64>()) {
        let out = format_php(centavos);
        let cents = out.rsplit('.').next().unwrap();
        prop_assert_eq!(cents.len(), 2, "not two centavo digits: {}", out);
    }
}
