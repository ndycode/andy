use andy_shared::{
    categories::{Category, coerce_category},
    time::{MANILA_OFFSET_MINUTES, current_week_start, days_in_local_month, local_date},
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::writes::{Cadence, DEDUP_KEY_MAX, OUTBOUND_CONTENT_MAX, PHONE_MAX, TxKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryRow {
    pub id: Uuid,
    pub content: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurringRow {
    pub id: Uuid,
    pub label: String,
    pub kind: TxKind,
    pub amount_centavos: i64,
    pub category: Category,
    pub cadence: Cadence,
    pub day_of_month: Option<i64>,
    pub day_of_week: Option<i64>,
    pub last_reminded_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundMessageRow {
    pub id: Uuid,
    pub phone: String,
    pub content: String,
    pub dedup_key: Option<String>,
    pub attempt_count: i64,
}

pub async fn list_memories(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<MemoryRow>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select id, content, kind::text as kind
        from memories
        where user_id = $1
        order by created_at desc
        limit $2
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(MemoryRow {
                id: row.try_get("id")?,
                content: row.try_get("content")?,
                kind: row.try_get("kind")?,
            })
        })
        .collect()
}

pub async fn claim_outbound_by_dedup_key(
    pool: &PgPool,
    dedup_key: &str,
) -> Result<Option<OutboundMessageRow>, sqlx::Error> {
    let dedup_key = truncate(dedup_key.trim(), DEDUP_KEY_MAX);
    if dedup_key.is_empty() {
        return Ok(None);
    }

    sqlx::query(
        r#"
        update outbound_messages
        set status = 'sending',
            attempt_count = attempt_count + 1,
            updated_at = now()
        where dedup_key = $1
          and (
            (status = 'pending' and next_attempt_at <= now())
            or (status = 'sending' and updated_at <= now() - interval '15 minutes')
          )
        returning id, phone, content, dedup_key, attempt_count
        "#,
    )
    .bind(dedup_key)
    .fetch_optional(pool)
    .await?
    .map(outbound_from_row)
    .transpose()
}

pub async fn claim_due_outbound_messages(
    pool: &PgPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<OutboundMessageRow>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        with claimed as (
          select id
          from outbound_messages
          where (status = 'pending' and next_attempt_at <= $1)
             or (status = 'sending' and updated_at <= $1 - interval '15 minutes')
          order by created_at asc
          limit $2
          for update skip locked
        )
        update outbound_messages outbound
        set status = 'sending',
            attempt_count = outbound.attempt_count + 1,
            updated_at = now()
        from claimed
        where outbound.id = claimed.id
        returning outbound.id, outbound.phone, outbound.content, outbound.dedup_key, outbound.attempt_count
        "#,
    )
    .bind(now)
    .bind(limit.clamp(1, 50))
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(outbound_from_row).collect()
}

pub async fn mark_outbound_sent(pool: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        update outbound_messages
        set status = 'sent',
            sent_at = now(),
            updated_at = now(),
            last_error = null
        where id = $1
        "#,
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record an outbound send failure. When the error is retryable and the
/// message still has attempts left, it goes back to `pending` with backoff.
/// When attempts are exhausted or the error is non-retryable (e.g. auth), it is
/// dead-lettered (`status = 'failed'`, `dead_lettered_at` set) so it can never
/// retry forever. Only acts on rows still in `sending` (the claimed state).
pub async fn mark_outbound_failed(
    pool: &PgPool,
    id: Uuid,
    error: &str,
    retryable: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        update outbound_messages
        set status = case
              when $3 and attempt_count < max_attempts then 'pending'
              else 'failed'
            end,
            dead_lettered_at = case
              when $3 and attempt_count < max_attempts then dead_lettered_at
              else now()
            end,
            last_error = $2,
            next_attempt_at = case
              when $3 and attempt_count < max_attempts
                then now() + make_interval(secs => least(3600, greatest(30, attempt_count * 30)))
              else next_attempt_at
            end,
            updated_at = now()
        where id = $1 and status = 'sending'
        "#,
    )
    .bind(id)
    .bind(truncate(error, OUTBOUND_CONTENT_MAX))
    .bind(retryable)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_nudge(
    pool: &PgPool,
    user_id: Uuid,
    kind: &str,
    at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let week = current_week_start(at, MANILA_OFFSET_MINUTES);
    let row = sqlx::query(
        r#"
        insert into nudges (user_id, kind, week_start_local_date)
        values ($1, $2, $3)
        on conflict do nothing
        returning kind
        "#,
    )
    .bind(user_id)
    .bind(kind)
    .bind(week)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn reap_nudges(
    pool: &PgPool,
    at: DateTime<Utc>,
    keep_weeks: i64,
) -> Result<u64, sqlx::Error> {
    let cutoff = current_week_start(at, MANILA_OFFSET_MINUTES) - Duration::days(keep_weeks * 7);
    let result = sqlx::query("delete from nudges where week_start_local_date < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

pub async fn has_summary_for_week(pool: &PgPool, at: DateTime<Utc>) -> Result<bool, sqlx::Error> {
    let week = current_week_start(at, MANILA_OFFSET_MINUTES);
    let row = sqlx::query(
        "select week_start_local_date from summary_runs where week_start_local_date = $1",
    )
    .bind(week)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn record_summary(pool: &PgPool, at: DateTime<Utc>) -> Result<bool, sqlx::Error> {
    let week = current_week_start(at, MANILA_OFFSET_MINUTES);
    let row = sqlx::query(
        r#"
        insert into summary_runs (week_start_local_date)
        values ($1)
        on conflict do nothing
        returning week_start_local_date
        "#,
    )
    .bind(week)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn reap_summary_runs(
    pool: &PgPool,
    at: DateTime<Utc>,
    keep_weeks: i64,
) -> Result<u64, sqlx::Error> {
    let cutoff = current_week_start(at, MANILA_OFFSET_MINUTES) - Duration::days(keep_weeks * 7);
    let result = sqlx::query("delete from summary_runs where week_start_local_date < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

pub async fn list_recurring(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<RecurringRow>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select id, label, kind::text as kind, amount_centavos, category::text as category,
               cadence::text as cadence, day_of_month, day_of_week, last_reminded_date
        from recurring_items
        where user_id = $1
        order by created_at asc, id asc
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(recurring_from_row).collect()
}

pub async fn due_recurring_today(
    pool: &PgPool,
    user_id: Uuid,
    at: DateTime<Utc>,
) -> Result<Vec<RecurringRow>, sqlx::Error> {
    let today = local_date(at, MANILA_OFFSET_MINUTES);
    let last_dom = i64::from(days_in_local_month(at, MANILA_OFFSET_MINUTES));
    let week_start = current_week_start(at, MANILA_OFFSET_MINUTES);
    let items = list_recurring(pool, user_id).await?;
    Ok(items
        .into_iter()
        .filter(|item| {
            if item.last_reminded_date == Some(today) {
                return false;
            }
            let due = if item.cadence == Cadence::Monthly {
                let Some(day) = item.day_of_month else {
                    return false;
                };
                NaiveDate::from_ymd_opt(today.year(), today.month(), day.min(last_dom) as u32)
                    .expect("valid recurring day")
            } else {
                let Some(day) = item.day_of_week else {
                    return false;
                };
                week_start + Duration::days((day + 6) % 7)
            };
            today >= due && item.last_reminded_date.is_none_or(|last| last < due)
        })
        .collect())
}

pub async fn claim_reminder(
    pool: &PgPool,
    id: Uuid,
    user_id: Uuid,
    at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let today = local_date(at, MANILA_OFFSET_MINUTES);
    let row = sqlx::query(
        r#"
        update recurring_items
        set last_reminded_date = $3, updated_at = now()
        where id = $1 and user_id = $2
          and last_reminded_date is distinct from $3
        returning id
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(today)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn reap_processed_messages(
    pool: &PgPool,
    at: DateTime<Utc>,
    keep_completed_days: i64,
    stale_claimed_hours: i64,
) -> Result<u64, sqlx::Error> {
    let completed_cutoff = at - Duration::days(keep_completed_days);
    let claimed_cutoff = at - Duration::hours(stale_claimed_hours);
    let result = sqlx::query(
        r#"
        delete from processed_messages
        where (status = 'completed' and completed_at < $1)
           or (status = 'claimed' and claimed_at < $2)
        "#,
    )
    .bind(completed_cutoff)
    .bind(claimed_cutoff)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn reap_messages(pool: &PgPool, user_id: Uuid, keep: i64) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        delete from messages
        where user_id = $1
          and seq < (
            select seq from messages
            where user_id = $1
            order by seq desc
            offset $2 limit 1
          )
        "#,
    )
    .bind(user_id)
    .bind(keep - 1)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn reconcile_goal_balances(pool: &PgPool, user_id: Uuid) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        update savings_goals
        set saved_centavos = coalesce((
            select sum(amount_centavos)
            from transactions
            where goal_id = savings_goals.id
        ), 0),
        updated_at = now()
        where user_id = $1
          and saved_centavos <> coalesce((
            select sum(amount_centavos)
            from transactions
            where goal_id = savings_goals.id
          ), 0)
        "#,
    )
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

fn recurring_from_row(row: sqlx::postgres::PgRow) -> Result<RecurringRow, sqlx::Error> {
    let category: String = row.try_get("category")?;
    let kind: String = row.try_get("kind")?;
    let cadence: String = row.try_get("cadence")?;
    Ok(RecurringRow {
        id: row.try_get("id")?,
        label: row.try_get("label")?,
        kind: TxKind::from_db(&kind)?,
        amount_centavos: row.try_get("amount_centavos")?,
        category: coerce_category(category),
        cadence: Cadence::from_db(&cadence)?,
        day_of_month: row.try_get("day_of_month")?,
        day_of_week: row.try_get("day_of_week")?,
        last_reminded_date: row.try_get("last_reminded_date")?,
    })
}

fn outbound_from_row(row: sqlx::postgres::PgRow) -> Result<OutboundMessageRow, sqlx::Error> {
    Ok(OutboundMessageRow {
        id: row.try_get("id")?,
        phone: truncate(row.try_get::<String, _>("phone")?.trim(), PHONE_MAX),
        content: truncate(
            row.try_get::<String, _>("content")?.trim(),
            OUTBOUND_CONTENT_MAX,
        ),
        dedup_key: row.try_get("dedup_key")?,
        attempt_count: i64::from(row.try_get::<i32, _>("attempt_count")?),
    })
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
