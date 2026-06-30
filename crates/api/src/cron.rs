use std::future::Future;

use andy_db::{
    budget_statuses, category_amounts_this_month, claim_reminder, due_recurring_today,
    get_month_overview, get_spending_by_category, has_summary_for_week, list_goals,
    reap_inbound_rate_limits, reap_messages, reap_nudges, reap_pending_confirmations,
    reap_processed_messages, reap_summary_runs, reconcile_goal_balances, record_nudge,
    record_summary, resolve_user_id,
};
use andy_shared::{
    analytics::{should_warn_pace, spending_pace},
    budget::BUDGET_NEAR_RATIO,
    goals::{GoalProgressInput, goal_pace, goal_progress_message},
    money::format_php,
    time::{
        MANILA_OFFSET_MINUTES, days_in_local_month, local_date, local_day_of_month,
        prev_month_anchor,
    },
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use tracing::{error, warn};
use uuid::Uuid;

use crate::outbound::{SendblueClient, deliver_due_outbound};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCheckResult {
    pub nudges: i64,
    pub pace_warnings: i64,
    pub reminders: i64,
    pub goal_nudges: i64,
    pub recap_sent: bool,
    pub reaped: i64,
    pub reaped_nudges: i64,
    pub reaped_summaries: i64,
    pub degraded: bool,
    pub outbound_sent: i64,
    pub outbound_failed: i64,
}

#[derive(Debug, Clone, Copy)]
struct HygieneResult {
    reaped: i64,
    reaped_nudges: i64,
    reaped_summaries: i64,
    degraded: bool,
}

pub async fn run_daily_checks(
    pool: &PgPool,
    sendblue: &SendblueClient,
    phone: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<DailyCheckResult> {
    let user_id = resolve_user_id(pool, phone).await?;
    let (outbound_sent, outbound_failed) = run_step(
        "cron.outbound.error",
        || async { Ok(deliver_due_outbound(pool, sendblue, now, 10).await?) },
        (0, 0),
    )
    .await;

    let hygiene = run_step(
        "cron.hygiene.error",
        || run_daily_hygiene(pool, user_id, now),
        HygieneResult {
            reaped: 0,
            reaped_nudges: 0,
            reaped_summaries: 0,
            degraded: true,
        },
    )
    .await;
    let (nudges, pace_warnings) = run_step(
        "cron.budget.error",
        || run_budget_checks(pool, sendblue, user_id, phone, now),
        (0, 0),
    )
    .await;
    let reminders = run_step(
        "cron.recurring.error",
        || run_recurring_reminders(pool, sendblue, user_id, phone, now),
        0,
    )
    .await;
    let goal_nudges = run_step(
        "cron.goal.error",
        || run_goal_pace_checks(pool, sendblue, user_id, phone, now),
        0,
    )
    .await;
    let recap_sent = run_step(
        "cron.recap.error",
        || run_weekly_summary(pool, sendblue, user_id, phone, now),
        false,
    )
    .await;

    Ok(DailyCheckResult {
        nudges,
        pace_warnings,
        reminders,
        goal_nudges,
        recap_sent,
        reaped: hygiene.reaped,
        reaped_nudges: hygiene.reaped_nudges,
        reaped_summaries: hygiene.reaped_summaries,
        degraded: hygiene.degraded,
        outbound_sent,
        outbound_failed,
    })
}

async fn run_step<T, F, Fut>(event: &'static str, f: F, fallback: T) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    match f().await {
        Ok(value) => value,
        Err(err) => {
            error!(event, error = %err);
            fallback
        }
    }
}

async fn run_daily_hygiene(
    pool: &PgPool,
    user_id: Uuid,
    now: DateTime<Utc>,
) -> anyhow::Result<HygieneResult> {
    let reaped = count_or_zero("cron.reap.error", || {
        reap_processed_messages(pool, now, 3, 24)
    })
    .await;
    let reaped_messages = count_or_zero("cron.reap_messages.error", || {
        reap_messages(pool, user_id, 200)
    })
    .await;
    let fixed = count_or_zero("cron.goal_reconcile.error", || {
        reconcile_goal_balances(pool, user_id)
    })
    .await;
    if fixed.0 > 0 {
        warn!(event = "cron.goal_reconcile.corrected", goals = fixed.0);
    }
    let reaped_nudges = count_or_zero("cron.reap_nudges.error", || reap_nudges(pool, now, 8)).await;
    let reaped_summaries = count_or_zero("cron.reap_summaries.error", || {
        reap_summary_runs(pool, now, 12)
    })
    .await;
    let reaped_confirmations = count_or_zero("cron.reap_confirmations.error", || {
        reap_pending_confirmations(pool, now)
    })
    .await;
    let reaped_rate_limits = count_or_zero("cron.reap_rate_limits.error", || {
        reap_inbound_rate_limits(pool, now, chrono::Duration::hours(24))
    })
    .await;

    Ok(HygieneResult {
        reaped: reaped.0 as i64,
        reaped_nudges: reaped_nudges.0 as i64,
        reaped_summaries: reaped_summaries.0 as i64,
        degraded: !(reaped.1
            && reaped_messages.1
            && fixed.1
            && reaped_nudges.1
            && reaped_summaries.1
            && reaped_confirmations.1
            && reaped_rate_limits.1),
    })
}

async fn count_or_zero<F, Fut>(event: &'static str, f: F) -> (u64, bool)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<u64, sqlx::Error>>,
{
    match f().await {
        Ok(count) => (count, true),
        Err(err) => {
            error!(event, error = %err);
            (0, false)
        }
    }
}

async fn run_budget_checks(
    pool: &PgPool,
    sendblue: &SendblueClient,
    user_id: Uuid,
    phone: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<(i64, i64)> {
    let dom = i64::from(local_day_of_month(now, MANILA_OFFSET_MINUTES));
    let dim = i64::from(days_in_local_month(now, MANILA_OFFSET_MINUTES));
    let mut nudges = 0;
    let mut pace_warnings = 0;

    for budget in budget_statuses(pool, user_id, now).await? {
        if budget.limit <= 0 {
            continue;
        }
        let ratio = budget.spent as f64 / budget.limit as f64;
        if ratio >= BUDGET_NEAR_RATIO {
            let kind = format!("budget:{}", budget.category);
            if record_nudge(pool, user_id, &kind, now).await? {
                let left = (budget.limit - budget.spent).max(0);
                let pct =
                    andy_shared::percent::percent_rounded(budget.spent, budget.limit).unwrap_or(0);
                let msg = format!(
                    "Budget heads-up: {} is at {} / {} ({}%). {} left this month.",
                    budget.category,
                    format_php(budget.spent),
                    format_php(budget.limit),
                    pct,
                    format_php(left)
                );
                send_isolated(sendblue, phone, &msg, "cron.nudge.error").await;
                nudges += 1;
            }
            continue;
        }

        let amounts = category_amounts_this_month(pool, user_id, budget.category, now).await?;
        let pace = spending_pace(
            budget.spent,
            dom,
            dim,
            budget.limit,
            Some(amounts.as_slice()),
        );
        if should_warn_pace(pace, dom, None, None, None) {
            let kind = format!("pace:{}", budget.category);
            if record_nudge(pool, user_id, &kind, now).await? {
                let msg = format!(
                    "{} is pacing toward {} this month, above the {} budget.",
                    budget.category,
                    format_php(pace.projected),
                    format_php(budget.limit)
                );
                send_isolated(sendblue, phone, &msg, "cron.pace.error").await;
                pace_warnings += 1;
            }
        }
    }

    Ok((nudges, pace_warnings))
}

async fn run_recurring_reminders(
    pool: &PgPool,
    sendblue: &SendblueClient,
    user_id: Uuid,
    phone: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<i64> {
    let mut reminders = 0;
    for item in due_recurring_today(pool, user_id, now).await? {
        if !claim_reminder(pool, item.id, user_id, now).await? {
            continue;
        }
        let msg = format!(
            "Reminder: {} {} {}.",
            item.label,
            format_php(item.amount_centavos),
            item.category
        );
        send_isolated(sendblue, phone, &msg, "cron.reminder.error").await;
        reminders += 1;
    }
    Ok(reminders)
}

async fn run_goal_pace_checks(
    pool: &PgPool,
    sendblue: &SendblueClient,
    user_id: Uuid,
    phone: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<i64> {
    let mut goal_nudges = 0;
    for goal in list_goals(pool, user_id).await? {
        if goal.target_date.is_none() {
            continue;
        }
        let input = GoalProgressInput {
            name: goal.name.clone(),
            saved_centavos: goal.saved_centavos,
            target_centavos: goal.target_centavos,
            created_at: goal.created_at,
            today: now,
            target_date: goal.target_date,
        };
        if goal_pace(&input).on_track {
            continue;
        }
        let kind = format!("goalpace:{}", goal.id);
        if record_nudge(pool, user_id, &kind, now).await? {
            let msg = format!("Goal pace heads-up: {}", goal_progress_message(&input));
            send_isolated(sendblue, phone, &msg, "cron.goalpace.error").await;
            goal_nudges += 1;
        }
    }
    Ok(goal_nudges)
}

async fn run_weekly_summary(
    pool: &PgPool,
    sendblue: &SendblueClient,
    user_id: Uuid,
    phone: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<bool> {
    if has_summary_for_week(pool, now).await? || !record_summary(pool, now).await? {
        return Ok(false);
    }

    let overview = get_month_overview(pool, user_id, now).await?;
    let by_category = get_spending_by_category(pool, user_id, now).await?;
    let prev_by_category =
        get_spending_by_category(pool, user_id, prev_month_anchor(now, MANILA_OFFSET_MINUTES))
            .await?;
    let goals = list_goals(pool, user_id).await?;
    let top = by_category
        .first()
        .map(|(category, total)| format!("Top category: {category} at {}.", format_php(*total)))
        .unwrap_or_else(|| "No category spending yet.".to_string());
    let prev_total = prev_by_category
        .iter()
        .map(|(_, total)| *total)
        .sum::<i64>();
    let active_goals = goals.len();
    let msg = format!(
        "Weekly recap: income {}, expenses {}, net {}. {} Last month category total was {}. Active goals: {}. Today: {}.",
        format_php(overview.income),
        format_php(overview.expense),
        format_php(overview.net),
        top,
        format_php(prev_total),
        active_goals,
        local_date(now, MANILA_OFFSET_MINUTES)
    );
    sendblue.send_message(phone, &msg).await?;
    Ok(true)
}

async fn send_isolated(sendblue: &SendblueClient, phone: &str, msg: &str, event: &'static str) {
    if let Err(err) = sendblue.send_message(phone, msg).await {
        error!(event, error = %err);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_result_serializes_camel_case() {
        let value = serde_json::to_value(DailyCheckResult {
            nudges: 1,
            pace_warnings: 2,
            reminders: 3,
            goal_nudges: 4,
            recap_sent: true,
            reaped: 5,
            reaped_nudges: 6,
            reaped_summaries: 7,
            degraded: false,
            outbound_sent: 8,
            outbound_failed: 9,
        })
        .unwrap();

        assert_eq!(value["paceWarnings"], 2);
        assert_eq!(value["goalNudges"], 4);
        assert_eq!(value["recapSent"], true);
        assert_eq!(value["outboundSent"], 8);
        assert_eq!(value["outboundFailed"], 9);
    }
}
