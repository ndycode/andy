use serde::{Deserialize, Serialize};

use crate::{budget::BUDGET_NEAR_RATIO, percent::percent_rounded};

const PCT_BASELINE_FLOOR_CENTAVOS: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    Up,
    Down,
    Flat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendingComparison {
    pub current: i64,
    pub previous: i64,
    pub delta: i64,
    pub pct_change: Option<i64>,
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaceVerdict {
    pub spent_so_far: i64,
    pub projected: i64,
    pub limit: i64,
    pub will_exceed: bool,
    pub projected_over: i64,
}

#[must_use]
pub fn spending_delta(current: i64, previous: i64) -> SpendingComparison {
    // saturating_sub, not `-`: extreme (current, previous) would overflow and
    // wrap with the WRONG SIGN in release (a decrease reported as an increase).
    // Saturating clamps to i64::MIN/MAX and preserves sign, keeping Direction
    // and pct_change coherent.
    let delta = current.saturating_sub(previous);
    let raw_pct = if previous < PCT_BASELINE_FLOOR_CENTAVOS {
        None
    } else {
        // Exact integer percent (i128 internally); previous >= floor > 0 so this
        // is always Some here.
        percent_rounded(delta, previous)
    };
    let pct_change = if raw_pct == Some(0) && delta != 0 {
        None
    } else {
        raw_pct
    };
    let direction = match delta.cmp(&0) {
        std::cmp::Ordering::Greater => Direction::Up,
        std::cmp::Ordering::Less => Direction::Down,
        std::cmp::Ordering::Equal => Direction::Flat,
    };
    SpendingComparison {
        current,
        previous,
        delta,
        pct_change,
        direction,
    }
}

#[must_use]
pub fn project_month_end(spent_so_far: i64, day_of_month: i64, days_in_month: i64) -> i64 {
    if day_of_month < 1 {
        return spent_so_far;
    }
    ((spent_so_far as f64 / day_of_month as f64) * days_in_month as f64).round() as i64
}

#[must_use]
pub fn project_month_end_robust(amounts: &[i64], day_of_month: i64, days_in_month: i64) -> i64 {
    // saturating fold, not sum::<i64>(): sum uses unchecked `+` and would
    // panic (debug) / silently wrap (release, money corruption) on extreme
    // aggregates. Saturating clamps instead.
    let spent_so_far = amounts.iter().copied().fold(0_i64, i64::saturating_add);
    if day_of_month < 1 {
        return spent_so_far;
    }
    if amounts.len() < 3 {
        return project_month_end(spent_so_far, day_of_month, days_in_month);
    }
    let mut sorted = amounts.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    let median = if sorted.len().is_multiple_of(2) {
        // Cast each operand to f64 BEFORE adding: the i64 pair-sum could
        // overflow pre-cast, producing a negative median that misclassifies
        // every amount.
        (sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0
    } else {
        sorted[mid] as f64
    };
    let threshold = median * 2.0;
    let mut outlier_total = 0_i64;
    let mut typical_total = 0_i64;
    for amount in amounts {
        if *amount as f64 > threshold {
            outlier_total = outlier_total.saturating_add(*amount);
        } else {
            typical_total = typical_total.saturating_add(*amount);
        }
    }
    if outlier_total == 0 {
        return project_month_end(spent_so_far, day_of_month, days_in_month);
    }
    // saturating_add the outlier total: the projection + outlier sum can
    // overflow i64 and wrap to a large negative in release.
    let typical_projection =
        ((typical_total as f64 / day_of_month as f64) * days_in_month as f64).round() as i64;
    let projected = typical_projection.saturating_add(outlier_total);
    projected.max(spent_so_far)
}

#[must_use]
pub fn spending_pace(
    spent_so_far: i64,
    day_of_month: i64,
    days_in_month: i64,
    limit: i64,
    amounts: Option<&[i64]>,
) -> PaceVerdict {
    let projected = amounts.map_or_else(
        || project_month_end(spent_so_far, day_of_month, days_in_month),
        |amounts| project_month_end_robust(amounts, day_of_month, days_in_month),
    );
    let has_budget = limit > 0;
    let will_exceed = has_budget && projected > limit;
    PaceVerdict {
        spent_so_far,
        projected,
        limit: if has_budget { limit } else { 0 },
        will_exceed,
        projected_over: if will_exceed { projected - limit } else { 0 },
    }
}

#[must_use]
pub fn should_warn_pace(
    verdict: PaceVerdict,
    day_of_month: i64,
    min_day: Option<i64>,
    near_ratio: Option<f64>,
    margin_ratio: Option<f64>,
) -> bool {
    let min_day = min_day.unwrap_or(5);
    let near_ratio = near_ratio.unwrap_or(BUDGET_NEAR_RATIO);
    let margin_ratio = margin_ratio.unwrap_or(0.1);
    if verdict.limit <= 0 || day_of_month < min_day {
        return false;
    }
    if verdict.spent_so_far as f64 >= verdict.limit as f64 * near_ratio {
        return false;
    }
    verdict.projected as f64 >= verdict.limit as f64 * (1.0 + margin_ratio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_spending_with_direction_and_percent() {
        assert_eq!(
            spending_delta(150, 100),
            SpendingComparison {
                current: 150,
                previous: 100,
                delta: 50,
                pct_change: Some(50),
                direction: Direction::Up,
            }
        );
        assert_eq!(spending_delta(1, 0).pct_change, None);
    }

    #[test]
    fn robust_projection_counts_outliers_once() {
        let projected = project_month_end_robust(&[100, 100, 10_000], 3, 30);
        assert_eq!(projected, 12_000);
    }

    #[test]
    fn pace_warning_requires_meaningful_projected_overshoot() {
        let verdict = spending_pace(1_000, 10, 30, 2_000, None);
        assert!(should_warn_pace(verdict, 10, None, None, None));
    }

    // Characterization: pin the delta/percent contract at its edges.
    #[test]
    fn spending_delta_edges() {
        // Denominator below the baseline floor -> no percent.
        assert_eq!(spending_delta(5_000, 99).pct_change, None);
        // Real drop reports a negative percent and Down direction.
        let down = spending_delta(50, 100);
        assert_eq!(down.pct_change, Some(-50));
        assert_eq!(down.direction, Direction::Down);
        // Sub-rounding change would round to 0% but delta != 0 -> suppressed.
        assert_eq!(spending_delta(10_001, 10_000).pct_change, None);
        // Flat.
        let flat = spending_delta(100, 100);
        assert_eq!(flat.delta, 0);
        assert_eq!(flat.direction, Direction::Flat);
        assert_eq!(flat.pct_change, Some(0));
    }

    #[test]
    fn robust_projection_without_outliers_matches_plain() {
        // No amount exceeds 2x median -> falls back to plain projection.
        let plain = project_month_end(300, 3, 30);
        assert_eq!(project_month_end_robust(&[100, 100, 100], 3, 30), plain);
    }

    #[test]
    fn robust_projection_even_count_uses_median_pair() {
        // 4 amounts: median = (100+100)/2 = 100, threshold 200, 10_000 is an
        // outlier counted once; typical (300) projected over the month + outlier.
        let projected = project_month_end_robust(&[100, 100, 100, 10_000], 3, 30);
        assert_eq!(projected, 13_000);
    }

    #[test]
    fn should_warn_pace_gates() {
        let verdict = spending_pace(1_000, 10, 30, 2_000, None);
        // Before min_day -> never warns.
        assert!(!should_warn_pace(verdict, 3, Some(5), None, None));
        // Already near the limit (spent >= limit*near_ratio) -> short-circuits.
        let near = spending_pace(1_900, 10, 30, 2_000, None);
        assert!(!should_warn_pace(near, 10, None, Some(0.9), None));
        // No budget -> never warns.
        let no_budget = spending_pace(1_000, 10, 30, 0, None);
        assert!(!should_warn_pace(no_budget, 10, None, None, None));
    }
}
