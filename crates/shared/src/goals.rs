use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::{money::format_php, percent::percent_rounded, time::local_date};

const DAY_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalProgressInput {
    pub name: String,
    pub saved_centavos: i64,
    pub target_centavos: i64,
    pub created_at: DateTime<Utc>,
    pub today: DateTime<Utc>,
    pub target_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalPaceVerdict {
    pub pct: i64,
    pub has_deadline: bool,
    pub on_track: bool,
    pub per_week_centavos: Option<i64>,
}

#[must_use]
pub fn goal_pace(goal: &GoalProgressInput) -> GoalPaceVerdict {
    let pct = percent_rounded(goal.saved_centavos, goal.target_centavos).unwrap_or(0);
    let Some(target_date) = goal.target_date else {
        return GoalPaceVerdict {
            pct,
            has_deadline: false,
            on_track: true,
            per_week_centavos: None,
        };
    };

    let saved_fraction = goal.saved_centavos as f64 / goal.target_centavos as f64;
    let created = local_date(goal.created_at, crate::time::MANILA_OFFSET_MINUTES);
    let today = local_date(goal.today, crate::time::MANILA_OFFSET_MINUTES);
    let span = target_date.signed_duration_since(created).num_days();
    let elapsed_fraction = if span > 0 {
        (today.signed_duration_since(created).num_days() as f64 / span as f64).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let on_track = saved_fraction >= elapsed_fraction;
    if on_track {
        return GoalPaceVerdict {
            pct,
            has_deadline: true,
            on_track: true,
            per_week_centavos: None,
        };
    }

    let weeks_remaining = target_date
        .and_hms_opt(0, 0, 0)
        .expect("valid target date")
        .and_utc()
        .signed_duration_since(goal.today)
        .num_seconds()
        .div_euclid(7 * DAY_SECONDS)
        .max(1);
    let remaining = goal.target_centavos - goal.saved_centavos;
    let per_week_centavos = (remaining + weeks_remaining - 1) / weeks_remaining;

    GoalPaceVerdict {
        pct,
        has_deadline: true,
        on_track: false,
        per_week_centavos: Some(per_week_centavos),
    }
}

#[must_use]
pub fn goal_progress_message(goal: &GoalProgressInput) -> String {
    let verdict = goal_pace(goal);
    let head = format!(
        "{}: {} / {} ({}%).",
        goal.name,
        format_php(goal.saved_centavos),
        format_php(goal.target_centavos),
        verdict.pct
    );
    let Some(target_date) = goal.target_date else {
        return format!("{head} No deadline set.");
    };
    let when = short_date(target_date);
    match verdict.per_week_centavos {
        None => format!("{head} On track to hit {when}."),
        Some(per_week) => {
            format!(
                "{head} Behind pace — save about {}/week to hit {when}.",
                format_php(per_week)
            )
        }
    }
}

fn short_date(date: NaiveDate) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!("{} {}", MONTHS[date.month0() as usize], date.day())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(value: &str) -> DateTime<Utc> {
        value.parse().unwrap()
    }

    #[test]
    fn reports_deadline_free_goal_on_track() {
        let goal = GoalProgressInput {
            name: "Laptop".into(),
            saved_centavos: 8_000,
            target_centavos: 20_000,
            created_at: dt("2026-06-01T00:00:00Z"),
            today: dt("2026-06-15T00:00:00Z"),
            target_date: None,
        };
        assert_eq!(goal_pace(&goal).pct, 40);
        assert!(goal_progress_message(&goal).contains("No deadline set"));
    }

    #[test]
    fn suggests_weekly_amount_when_behind() {
        let goal = GoalProgressInput {
            name: "Trip".into(),
            saved_centavos: 2_000,
            target_centavos: 20_000,
            created_at: dt("2026-06-01T00:00:00Z"),
            today: dt("2026-06-15T00:00:00Z"),
            target_date: Some("2026-07-01".parse().unwrap()),
        };
        assert!(!goal_pace(&goal).on_track);
        assert!(goal_progress_message(&goal).contains("Behind pace"));
    }
}
