//! Pending write-confirmation storage (Phase 4).
//!
//! When a turn is risky, the inbound handler parks its writes here and asks the
//! user to confirm. A later "yes" loads the latest non-expired row and applies
//! its writes; "no"/"cancel" cancels it. Payloads are the serialized
//! [`WriteIntent`] list, so confirmation reuses the exact same flush path.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::writes::{PHONE_MAX, WriteIntent};

/// A stored, still-actionable confirmation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingConfirmation {
    pub id: Uuid,
    pub summary: String,
    pub writes: Vec<WriteIntent>,
}

/// Park a turn's writes pending user confirmation. `summary` is the short
/// human description shown back to the user; `expires_at` bounds how long a
/// later "yes" can apply it.
///
/// Idempotent per `source_message_id`: a retry of the same inbound message
/// (e.g. after its processed-messages claim goes stale) will not create a
/// second pending row, so two later "yes" replies cannot apply the same risky
/// writes twice. Relies on the partial unique index from migration 0020.
pub async fn save_pending_confirmation(
    pool: &PgPool,
    user_id: Uuid,
    phone: &str,
    source_message_id: Option<&str>,
    summary: &str,
    writes: &[WriteIntent],
    expires_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let payload = serde_json::to_value(writes).map_err(|err| sqlx::Error::Encode(Box::new(err)))?;
    let phone = truncate(phone.trim(), PHONE_MAX);
    let summary = truncate(summary.trim(), 500);
    sqlx::query(
        r#"
        insert into pending_confirmations
          (user_id, phone, source_message_id, summary, payload_json, expires_at)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (source_message_id) where source_message_id is not null
          do nothing
        "#,
    )
    .bind(user_id)
    .bind(phone)
    .bind(source_message_id)
    .bind(summary)
    .bind(payload)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Load the latest still-pending, non-expired confirmation for a user without
/// consuming it. Returns `None` when there is nothing to confirm.
pub async fn latest_pending_confirmation(
    pool: &PgPool,
    user_id: Uuid,
    now: DateTime<Utc>,
) -> Result<Option<PendingConfirmation>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        select id, summary, payload_json
        from pending_confirmations
        where user_id = $1 and status = 'pending' and expires_at > $2
        order by created_at desc
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(now)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let payload: serde_json::Value = row.try_get("payload_json")?;
    let writes: Vec<WriteIntent> =
        serde_json::from_value(payload).map_err(|err| sqlx::Error::Decode(Box::new(err)))?;
    Ok(Some(PendingConfirmation {
        id: row.try_get("id")?,
        summary: row.try_get("summary")?,
        writes,
    }))
}

/// Atomically consume one pending confirmation. Returns true only if it was
/// still pending (guards against a double "yes" racing two applies).
pub async fn consume_confirmation(
    pool: &PgPool,
    id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        r#"
        update pending_confirmations
        set status = 'consumed'
        where id = $1 and user_id = $2 and status = 'pending'
        returning id
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Transaction-scoped consume, used by `flush_writes` so the consume and the
/// parked writes commit (or roll back) together. Returns true if the row was
/// still pending. When this returns false the caller must abort the flush so a
/// double "yes" or a superseded retry cannot re-apply the writes.
pub(crate) async fn consume_confirmation_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        r#"
        update pending_confirmations
        set status = 'consumed'
        where id = $1 and user_id = $2 and status = 'pending'
        returning id
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}

/// Cancel every still-pending confirmation for a user (used on "no"/"cancel").
/// Returns how many were cancelled.
pub async fn cancel_pending_confirmations(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let result =
        sqlx::query("update pending_confirmations set status = 'cancelled' where user_id = $1 and status = 'pending'")
            .bind(user_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

/// Delete old terminal/expired rows so the table does not grow unbounded.
pub async fn reap_pending_confirmations(
    pool: &PgPool,
    now: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        delete from pending_confirmations
        where status <> 'pending' or expires_at < $1
        "#,
    )
    .bind(now)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
