use serde::{Deserialize, Serialize};

use crate::budget::BUDGET_NEAR_RATIO;

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
    let delta = current - previous;
    let raw_pct = if previous < PCT_BASELINE_FLOOR_CENTAVOS {
        None
    } else {
        Some(((delta as f64 / previous as f64) * 100.0).round() as i64)
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
    let spent_so_far = amounts.iter().sum::<i64>();
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
        (sorted[mid - 1] + sorted[mid]) as f64 / 2.0
    } else {
        sorted[mid] as f64
    };
    let threshold = median * 2.0;
    let mut outlier_total = 0_i64;
    let mut typical_total = 0_i64;
    for amount in amounts {
        if *amount as f64 > threshold {
            outlier_total += amount;
        } else {
            typical_total += amount;
        }
    }
    if outlier_total == 0 {
        return project_month_end(spent_so_far, day_of_month, days_in_month);
    }
    let projected = ((typical_total as f64 / day_of_month as f64) * days_in_month as f64).round()
        as i64
        + outlier_total;
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
}
