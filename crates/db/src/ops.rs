use andy_shared::{
    categories::{Category, coerce_category},
    time::{MANILA_OFFSET_MINUTES, current_week_start, days_in_local_month, local_date},
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::writes::RecurringInput;

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
    pub kind: String,
    pub amount_centavos: i64,
    pub category: Category,
    pub cadence: String,
    pub day_of_month: Option<i64>,
    pub day_of_week: Option<i64>,
    pub last_reminded_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InsightSummary {
    pub weekend_centavos: i64,
    pub weekday_centavos: i64,
    pub top_leak: Option<TopLeak>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopLeak {
    pub note: String,
    pub centavos: i64,
}

pub async fn save_memory(
    pool: &PgPool,
    user_id: Uuid,
    content: &str,
    kind: &str,
) -> Result<(), sqlx::Error> {
    let trimmed = truncate(content.trim(), 4000);
    if trimmed.is_empty() {
        return Ok(());
    }
    let normalized = normalize_memory_content(&trimmed);
    let compact = compact_memory_content(&trimmed);
    if compact.is_empty() {
        return Ok(());
    }
    let existing = sqlx::query(
        r#"
        select id, kind::text as kind
        from memories
        where user_id = $1
          and (
            lower(btrim(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))) = $2
            or regexp_replace(lower(btrim(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))), '\s+', '', 'g') = $3
          )
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(&normalized)
    .bind(&compact)
    .fetch_optional(pool)
    .await?;

    if let Some(existing) = existing {
        let id: Uuid = existing.try_get("id")?;
        let current_kind: String = existing.try_get("kind")?;
        if should_promote_memory_kind(&current_kind, kind) {
            sqlx::query(
                "update memories set kind = $3::memory_kind where id = $1 and user_id = $2",
            )
            .bind(id)
            .bind(user_id)
            .bind(kind)
            .execute(pool)
            .await?;
        }
        return Ok(());
    }

    sqlx::query("insert into memories (user_id, content, kind) values ($1, $2, $3::memory_kind)")
        .bind(user_id)
        .bind(trimmed)
        .bind(kind)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn recall_memories(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    query: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let fetch_limit = (limit * 8).clamp(60, 200);
    let rows = sqlx::query(
        r#"
        select content, kind::text as kind
        from memories
        where user_id = $1
        order by case kind
          when 'payday' then 0
          when 'fact' then 1
          when 'preference' then 1
          when 'goal' then 2
          else 3 end,
          created_at desc
        limit $2
        "#,
    )
    .bind(user_id)
    .bind(fetch_limit)
    .fetch_all(pool)
    .await?;
    let rows = rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("content")?,
                row.try_get::<String, _>("kind")?,
            ))
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(select_prompt_memories(&rows, limit as usize, query))
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

pub async fn forget_memory(
    pool: &PgPool,
    user_id: Uuid,
    query: &str,
) -> Result<Option<String>, sqlx::Error> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(None);
    }
    let normalized = normalize_memory_content(q);
    let compact = compact_memory_content(q);
    if compact.is_empty() {
        return Ok(None);
    }
    let hit = sqlx::query(
        r#"
        select id, content
        from memories
        where user_id = $1
          and (
            lower(btrim(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))) = $2
            or regexp_replace(lower(btrim(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))), '\s+', '', 'g') = $3
          )
        order by created_at desc
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(&normalized)
    .bind(&compact)
    .fetch_optional(pool)
    .await?;
    let hit = if let Some(hit) = hit {
        hit
    } else {
        sqlx::query(
            r#"
            select id, content
            from memories
            where user_id = $1
              and (
                lower(btrim(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))) like $2 escape '\'
                or regexp_replace(lower(btrim(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))), '\s+', '', 'g') like $3 escape '\'
              )
            order by created_at desc
            limit 1
            "#,
        )
        .bind(user_id)
        .bind(format!("%{}%", escape_like(&normalized)))
        .bind(format!("%{}%", escape_like(&compact)))
        .fetch_optional(pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?
    };
    let id: Uuid = hit.try_get("id")?;
    let content: String = hit.try_get("content")?;
    sqlx::query("delete from memories where id = $1 and user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(Some(content))
}

pub async fn learn_habit(
    pool: &PgPool,
    user_id: Uuid,
    merchant: &str,
    category: Category,
) -> Result<(), sqlx::Error> {
    let keys = note_keywords(merchant);
    for key in keys {
        sqlx::query(
            r#"
            insert into habits (user_id, merchant, category, count)
            values ($1, $2, $3::category, 1)
            on conflict (user_id, merchant) do update
              set category = excluded.category,
                  count = case when habits.category = excluded.category then habits.count + 1 else 1 end,
                  updated_at = now()
            "#,
        )
        .bind(user_id)
        .bind(key)
        .bind(category.as_str())
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn top_habits(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    min_count: i64,
) -> Result<Vec<(String, Category)>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select merchant, category::text as category
        from habits
        where user_id = $1 and count >= $2
        order by count desc, updated_at desc, merchant asc
        limit $3
        "#,
    )
    .bind(user_id)
    .bind(min_count)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let category: String = row.try_get("category")?;
            Ok((row.try_get("merchant")?, coerce_category(category)))
        })
        .collect()
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

pub async fn add_recurring(
    pool: &PgPool,
    user_id: Uuid,
    recurring: &RecurringInput,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        insert into recurring_items
          (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
        values ($1, $2, $3::tx_kind, $4, $5::category, $6::cadence, $7, $8)
        on conflict (user_id, lower(label)) do update
          set label = excluded.label,
              kind = excluded.kind,
              amount_centavos = excluded.amount_centavos,
              category = excluded.category,
              cadence = excluded.cadence,
              day_of_month = excluded.day_of_month,
              day_of_week = excluded.day_of_week,
              updated_at = now()
        "#,
    )
    .bind(user_id)
    .bind(truncate(&recurring.label, 100))
    .bind(recurring.kind.as_db())
    .bind(recurring.amount_centavos)
    .bind(recurring.category.as_str())
    .bind(recurring.cadence.as_db())
    .bind(recurring.day_of_month)
    .bind(recurring.day_of_week)
    .execute(pool)
    .await?;
    Ok(())
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

pub async fn find_recurring_by_label(
    pool: &PgPool,
    user_id: Uuid,
    label: &str,
) -> Result<Option<RecurringRow>, sqlx::Error> {
    let matches = find_recurring_matches(pool, user_id, label).await?;
    Ok((matches.len() == 1).then(|| matches[0].clone()))
}

pub async fn find_recurring_matches(
    pool: &PgPool,
    user_id: Uuid,
    label: &str,
) -> Result<Vec<RecurringRow>, sqlx::Error> {
    Ok(match_recurring(list_recurring(pool, user_id).await?, label))
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
            let due = if item.cadence == "monthly" {
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

pub async fn get_insights(
    pool: &PgPool,
    user_id: Uuid,
    at: DateTime<Utc>,
) -> Result<InsightSummary, sqlx::Error> {
    let (start, end) = andy_shared::time::month_range(at, MANILA_OFFSET_MINUTES);
    let weekend = sqlx::query(
        r#"
        select
          coalesce(sum(case when extract(dow from local_date) in (0,6) then amount_centavos else 0 end),0)::bigint as weekend,
          coalesce(sum(case when extract(dow from local_date) not in (0,6) then amount_centavos else 0 end),0)::bigint as weekday
        from transactions
        where user_id = $1 and kind = 'expense' and local_date between $2 and $3
        "#,
    )
    .bind(user_id)
    .bind(start)
    .bind(end)
    .fetch_one(pool)
    .await?;
    let leak = sqlx::query(
        r#"
        select max(note) as note, sum(amount_centavos)::bigint as total
        from transactions
        where user_id = $1 and kind = 'expense' and local_date between $2 and $3
          and note is not null and trim(note) <> ''
        group by lower(trim(note))
        order by sum(amount_centavos) desc, lower(trim(note)) asc
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(start)
    .bind(end)
    .fetch_optional(pool)
    .await?;
    Ok(InsightSummary {
        weekend_centavos: weekend.try_get("weekend")?,
        weekday_centavos: weekend.try_get("weekday")?,
        top_leak: leak
            .map(|row| {
                Ok::<TopLeak, sqlx::Error>(TopLeak {
                    note: row.try_get("note")?,
                    centavos: row.try_get("total")?,
                })
            })
            .transpose()?,
    })
}

fn recurring_from_row(row: sqlx::postgres::PgRow) -> Result<RecurringRow, sqlx::Error> {
    let category: String = row.try_get("category")?;
    Ok(RecurringRow {
        id: row.try_get("id")?,
        label: row.try_get("label")?,
        kind: row.try_get("kind")?,
        amount_centavos: row.try_get("amount_centavos")?,
        category: coerce_category(category),
        cadence: row.try_get("cadence")?,
        day_of_month: row.try_get("day_of_month")?,
        day_of_week: row.try_get("day_of_week")?,
        last_reminded_date: row.try_get("last_reminded_date")?,
    })
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn normalize_memory_content(content: &str) -> String {
    content
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn compact_memory_content(content: &str) -> String {
    normalize_memory_content(content).replace(' ', "")
}

fn should_promote_memory_kind(current: &str, next: &str) -> bool {
    memory_kind_rank(next) < memory_kind_rank(current)
}

fn memory_kind_rank(kind: &str) -> i64 {
    match kind {
        "payday" => 0,
        "fact" | "preference" => 1,
        "goal" => 2,
        _ => 3,
    }
}

fn select_prompt_memories(rows: &[(String, String)], limit: usize, query: &str) -> Vec<String> {
    let query_tokens = keywords(query);
    let mut seen = std::collections::HashSet::new();
    let mut ranked = rows
        .iter()
        .enumerate()
        .filter_map(|(index, (content, kind))| {
            let key = compact_memory_content(content);
            if !seen.insert(key) {
                return None;
            }
            let relevance = relevance_score(content, &query_tokens);
            Some((content.clone(), kind.clone(), relevance, index))
        })
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(_, kind, relevance, index)| {
        (
            std::cmp::Reverse(*relevance),
            memory_kind_rank(kind),
            *index,
        )
    });
    if !query_tokens.is_empty() {
        let relevant = ranked
            .iter()
            .filter(|(_, _, relevance, _)| *relevance > 0)
            .take(limit)
            .map(|(content, _, _, _)| content.clone())
            .collect::<Vec<_>>();
        if !relevant.is_empty() || is_focused_memory_query(query) {
            return relevant;
        }
    }
    ranked
        .into_iter()
        .take(limit)
        .map(|(content, _, _, _)| content)
        .collect()
}

fn relevance_score(content: &str, query_tokens: &[String]) -> i64 {
    let content_tokens = keywords(content)
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    query_tokens
        .iter()
        .filter(|token| content_tokens.contains(*token))
        .count() as i64
        * 2
}

fn is_focused_memory_query(query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    [
        "remember",
        "told you",
        "you know",
        "usual",
        "default",
        "favorite",
        "favourite",
        "go-to",
        "prefer",
        "like",
        "love",
        "hate",
        "payday",
        "salary",
        "sweldo",
        "address",
        "home",
        "office",
        "live",
        "work",
        "location",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn keywords(value: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "about", "also", "andy", "are", "can", "did", "does", "for", "have", "how", "into", "know",
        "like", "list", "make", "much", "now", "please", "remember", "show", "tell", "that", "the",
        "this", "til", "today", "what", "when", "where", "which", "who", "why", "with", "you",
    ];
    let mut tokens = value
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3 && !STOPWORDS.contains(token))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let base = tokens.clone();
    for token in base {
        match token.as_str() {
            "boba" => tokens.push("milktea".into()),
            "paid" | "pay" | "paycheck" | "salary" | "sweldo" => {
                tokens.push("payday".into());
                tokens.push("salary".into());
            }
            _ => {}
        }
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn note_keywords(note: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &["the", "and", "for", "with", "from", "paid"];
    let mut tokens = note
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3 && !STOPWORDS.contains(token))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    tokens.sort();
    tokens.dedup();
    tokens
}

fn match_recurring(items: Vec<RecurringRow>, query: &str) -> Vec<RecurringRow> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let exact = items
        .iter()
        .filter(|item| item.label.eq_ignore_ascii_case(&q))
        .cloned()
        .collect::<Vec<_>>();
    if !exact.is_empty() {
        return exact;
    }
    let contains = items
        .into_iter()
        .filter(|item| item.label.to_ascii_lowercase().contains(&q))
        .collect::<Vec<_>>();
    if contains.len() == 1 {
        contains
    } else if contains.is_empty() {
        Vec::new()
    } else {
        contains
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_selection_dedupes_and_filters_relevant_rows() {
        let rows = vec![
            ("I like milk tea".to_string(), "preference".to_string()),
            ("i like milktea".to_string(), "fact".to_string()),
            ("Payday is Friday".to_string(), "payday".to_string()),
        ];
        assert_eq!(
            select_prompt_memories(&rows, 2, "when is sweldo"),
            vec!["Payday is Friday".to_string()]
        );
    }

    #[test]
    fn note_keywords_are_lowercase_deduped() {
        assert_eq!(note_keywords("Grab grab paid"), vec!["grab"]);
    }
}
