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

    // Characterization: lock the exact per_week_centavos ceil-division contract.
    // per_week = ceil(remaining / weeks_remaining); weeks_remaining is the whole
    // weeks (floored, min 1) between `today` and target midnight UTC.
    #[test]
    fn per_week_two_weeks_out_is_exact_half() {
        // remaining 18_000 over 2 whole weeks -> 9_000/week.
        let goal = GoalProgressInput {
            name: "Trip".into(),
            saved_centavos: 2_000,
            target_centavos: 20_000,
            created_at: dt("2026-06-01T00:00:00Z"),
            today: dt("2026-06-08T00:00:00Z"),
            target_date: Some("2026-06-22".parse().unwrap()),
        };
        let v = goal_pace(&goal);
        assert!(!v.on_track);
        assert_eq!(v.per_week_centavos, Some(9_000));
    }

    #[test]
    fn per_week_three_weeks_out_divides_evenly() {
        // remaining 18_000 over 3 whole weeks -> 6_000/week.
        let goal = GoalProgressInput {
            name: "Trip".into(),
            saved_centavos: 2_000,
            target_centavos: 20_000,
            created_at: dt("2026-06-01T00:00:00Z"),
            today: dt("2026-06-08T00:00:00Z"),
            target_date: Some("2026-07-02".parse().unwrap()),
        };
        let v = goal_pace(&goal);
        assert!(!v.on_track);
        assert_eq!(v.per_week_centavos, Some(6_000));
    }

    #[test]
    fn per_week_rounds_up_remainder() {
        // remaining 10_000 over 3 whole weeks -> ceil(3333.3) = 3_334/week.
        // Long span keeps us behind pace while 3 weeks still remain.
        let goal = GoalProgressInput {
            name: "House".into(),
            saved_centavos: 30_000,
            target_centavos: 40_000,
            created_at: dt("2026-01-01T00:00:00Z"),
            today: dt("2026-08-05T00:00:00Z"),
            target_date: Some("2026-08-29".parse().unwrap()),
        };
        let v = goal_pace(&goal);
        assert!(!v.on_track);
        assert_eq!(v.per_week_centavos, Some(3_334));
    }

    #[test]
    fn on_track_when_saved_fraction_meets_elapsed_fraction() {
        // Halfway through the span with half saved -> exactly on track.
        let goal = GoalProgressInput {
            name: "Even".into(),
            saved_centavos: 10_000,
            target_centavos: 20_000,
            created_at: dt("2026-06-01T00:00:00Z"),
            today: dt("2026-06-11T00:00:00Z"),
            target_date: Some("2026-06-21".parse().unwrap()),
        };
        let v = goal_pace(&goal);
        assert!(v.on_track);
        assert_eq!(v.per_week_centavos, None);
    }

    #[test]
    fn nonpositive_span_treats_deadline_as_elapsed() {
        // target_date on or before created_at -> span <= 0 -> elapsed_fraction 1.0,
        // so any goal under target is behind and weeks_remaining floors to 1.
        let goal = GoalProgressInput {
            name: "Past".into(),
            saved_centavos: 2_000,
            target_centavos: 20_000,
            created_at: dt("2026-06-01T00:00:00Z"),
            today: dt("2026-06-01T00:00:00Z"),
            target_date: Some("2026-05-01".parse().unwrap()),
        };
        let v = goal_pace(&goal);
        assert!(v.has_deadline);
        assert!(!v.on_track);
        assert_eq!(v.per_week_centavos, Some(18_000));
    }
}
