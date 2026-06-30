//! Durable, cross-instance inbound rate limiting (Phase 6).
//!
//! The process-local burst limiter is useless across serverless instances.
//! This counts requests per fixed window in Postgres, keyed by a caller-
//! supplied hash (never a raw token or phone). The webhook fails closed if this
//! check errors, so unknown traffic never silently bypasses the limit.

use chrono::{DateTime, Duration, Utc};
use sqlx::{PgPool, Row};

/// Outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateDecision {
    Allow,
    Limited,
}

/// Atomically increment the counter for `key_hash` in the current fixed window
/// and decide whether the request is allowed. The window start is `now`
/// truncated to a multiple of `window_seconds`. Returns `Limited` once the
/// count for the window exceeds `limit`.
pub async fn check_and_increment(
    pool: &PgPool,
    key_hash: &str,
    now: DateTime<Utc>,
    window_seconds: i64,
    limit: i64,
) -> Result<RateDecision, sqlx::Error> {
    let window = window_seconds.max(1);
    let bucket_start = window_start(now, window);
    let row = sqlx::query(
        r#"
        insert into inbound_rate_limits (key_hash, bucket_start, count)
        values ($1, $2, 1)
        on conflict (key_hash, bucket_start) do update
          set count = inbound_rate_limits.count + 1
        returning count
        "#,
    )
    .bind(key_hash)
    .bind(bucket_start)
    .fetch_one(pool)
    .await?;
    let count: i32 = row.try_get("count")?;
    Ok(if i64::from(count) > limit.max(1) {
        RateDecision::Limited
    } else {
        RateDecision::Allow
    })
}

/// Delete rate-limit rows whose window ended before `now - keep`. Cheap GC for
/// the daily cron.
pub async fn reap_inbound_rate_limits(
    pool: &PgPool,
    now: DateTime<Utc>,
    keep: Duration,
) -> Result<u64, sqlx::Error> {
    let cutoff = now - keep;
    let result = sqlx::query("delete from inbound_rate_limits where bucket_start < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Truncate `now` down to the start of its fixed window.
fn window_start(now: DateTime<Utc>, window_seconds: i64) -> DateTime<Utc> {
    let secs = now.timestamp();
    let start = secs - secs.rem_euclid(window_seconds);
    DateTime::from_timestamp(start, 0).unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_start_truncates_to_window() {
        let now = "2026-06-15T12:00:37Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            window_start(now, 60).to_rfc3339(),
            "2026-06-15T12:00:00+00:00"
        );
        assert_eq!(
            window_start(now, 30).to_rfc3339(),
            "2026-06-15T12:00:30+00:00"
        );
    }
}
