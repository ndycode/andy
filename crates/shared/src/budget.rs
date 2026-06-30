use crate::{categories::Category, money::format_php, percent::percent_rounded};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetSnapshot {
    pub category: Category,
    pub limit: i64,
    pub spent: i64,
}

pub const BUDGET_NEAR_RATIO: f64 = 0.8;
/// Integer counterpart of [`BUDGET_NEAR_RATIO`] for exact percent comparisons.
pub const BUDGET_NEAR_PERCENT: i64 = 80;

#[must_use]
pub fn counts_toward_budget_reaction(local_date: NaiveDate, month: (NaiveDate, NaiveDate)) -> bool {
    local_date >= month.0 && local_date <= month.1
}

#[must_use]
pub fn budget_reaction_line(current: BudgetSnapshot, prior_spent: i64) -> Option<String> {
    if current.limit <= 0 {
        return None;
    }

    let crossed_now = current.spent * 100 >= BUDGET_NEAR_PERCENT * current.limit;
    let crossed_before = prior_spent * 100 >= BUDGET_NEAR_PERCENT * current.limit;

    if current.spent > current.limit && prior_spent <= current.limit {
        let over = current.spent - current.limit;
        return Some(format!(
            "heads up, that puts you over your {} budget by {} this month 😬",
            current.category,
            format_php(over)
        ));
    }

    if crossed_now && !crossed_before {
        let pct = percent_rounded(current.spent, current.limit).unwrap_or(0);
        let left = (current.limit - current.spent).max(0);
        return Some(format!(
            "that's {pct}% of your {} budget, {} left for the month 👀",
            current.category,
            format_php(left)
        ));
    }

    None
}

#[must_use]
pub fn budget_reaction_lines(
    statuses: &[BudgetSnapshot],
    just_logged_by_category: &HashMap<Category, i64>,
) -> Vec<String> {
    statuses
        .iter()
        .filter_map(|status| {
            let just_logged = just_logged_by_category
                .get(&status.category)
                .copied()
                .unwrap_or_default();
            budget_reaction_line(*status, status.spent - just_logged)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_once_when_crossing_near_budget() {
        let status = BudgetSnapshot {
            category: Category::Food,
            limit: 10_000,
            spent: 8_000,
        };
        assert_eq!(
            budget_reaction_line(status, 7_900),
            Some("that's 80% of your Food budget, ₱20.00 left for the month 👀".to_string())
        );
        assert_eq!(budget_reaction_line(status, 8_000), None);
    }

    #[test]
    fn warns_when_crossing_over_budget() {
        let status = BudgetSnapshot {
            category: Category::Bills,
            limit: 10_000,
            spent: 12_500,
        };
        assert_eq!(
            budget_reaction_line(status, 9_000),
            Some("heads up, that puts you over your Bills budget by ₱25.00 this month 😬".into())
        );
    }
}
