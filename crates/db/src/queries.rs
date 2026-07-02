use andy_shared::{
    allowlist::normalize_phone,
    categories::{Category, coerce_category},
    time::{MANILA_OFFSET_MINUTES, month_range},
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::sql::escape_like;
use crate::writes::{message_role_from_db, tx_kind_from_db};

pub const CLAIM_TTL_MS: i64 = 2 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimResult {
    Process,
    Skip,
}

// Row DTOs and the transaction-search input now live in andy_shared::domain
// (pure value types). db owns only the sqlx row-mapping glue below. Re-exported
// so existing `andy_db::{TransactionRow, GoalRow, ...}` paths keep working.
pub use andy_shared::domain::{
    BudgetStatus, ConversationTurn, GoalRow, MonthOverview, TransactionRow, TransactionSearch,
    TransactionSummaryRow, TransferRow,
};

/// Recent transfers (account-to-account movements), newest first. Optional
/// `account` filters to transfers touching that account on either side.
pub async fn search_transfers(
    pool: &PgPool,
    user_id: Uuid,
    account: Option<&str>,
    limit: i64,
) -> Result<Vec<TransferRow>, sqlx::Error> {
    let limit = limit.clamp(1, 50);
    let account = account
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    let rows = sqlx::query(
        r#"
        select amount_centavos, from_account, to_account, note, local_date
        from transfers
        where user_id = $1
          and ($2::text is null
               or lower(coalesce(from_account, '')) = lower($2)
               or lower(coalesce(to_account, '')) = lower($2))
        order by local_date desc, created_at desc
        limit $3
        "#,
    )
    .bind(user_id)
    .bind(account)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(TransferRow {
                amount_centavos: row.try_get("amount_centavos")?,
                from_account: row.try_get("from_account")?,
                to_account: row.try_get("to_account")?,
                note: row.try_get("note")?,
                local_date: row.try_get("local_date")?,
            })
        })
        .collect()
}

pub async fn claim_slot(
    pool: &PgPool,
    message_id: &str,
    now: DateTime<Utc>,
) -> Result<ClaimResult, sqlx::Error> {
    let stale_before = now - Duration::milliseconds(CLAIM_TTL_MS);
    let row = sqlx::query(
        r#"
        insert into processed_messages (message_id, status, claimed_at, completed_at)
        values ($1, 'claimed', $2, null)
        on conflict (message_id) do update
          set status = 'claimed', claimed_at = $2, completed_at = null
          where processed_messages.status = 'claimed'
            and processed_messages.claimed_at <= $3
        returning message_id
        "#,
    )
    .bind(message_id)
    .bind(now)
    .bind(stale_before)
    .fetch_optional(pool)
    .await?;

    Ok(if row.is_some() {
        ClaimResult::Process
    } else {
        ClaimResult::Skip
    })
}

pub async fn resolve_user_id(pool: &PgPool, phone: &str) -> Result<Uuid, sqlx::Error> {
    let normalized = normalize_phone(phone);
    let row = sqlx::query(
        r#"
        insert into users (phone)
        values ($1)
        on conflict (phone) do update set phone = excluded.phone
        returning id
        "#,
    )
    .bind(normalized)
    .fetch_one(pool)
    .await?;
    row.try_get("id")
}

pub async fn recent_turns(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<ConversationTurn>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select role::text as role, content
        from messages
        where user_id = $1
        order by seq desc
        limit $2
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut turns = rows
        .into_iter()
        .map(|row| {
            let role: String = row.try_get("role")?;
            Ok(ConversationTurn {
                role: message_role_from_db(&role)?,
                content: row.try_get("content")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    turns.reverse();
    Ok(turns)
}

pub async fn last_transaction(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Option<TransactionRow>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        select id, kind::text as kind, amount_centavos, category::text as category,
               note, goal_id, local_date
        from transactions
        where user_id = $1
        order by seq desc
        limit 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    row.map(transaction_from_row).transpose()
}

pub async fn budget_statuses(
    pool: &PgPool,
    user_id: Uuid,
    at: DateTime<Utc>,
) -> Result<Vec<BudgetStatus>, sqlx::Error> {
    let (month_start, month_end) = month_range(at, MANILA_OFFSET_MINUTES);
    budget_status_rows(pool, user_id, None, month_start, month_end).await
}

pub async fn budget_statuses_for(
    pool: &PgPool,
    user_id: Uuid,
    categories: &[Category],
    month_start: NaiveDate,
    month_end: NaiveDate,
) -> Result<Vec<BudgetStatus>, sqlx::Error> {
    if categories.is_empty() {
        return Ok(Vec::new());
    }
    let category_strings = categories
        .iter()
        .map(|category| category.as_str().to_string())
        .collect::<Vec<_>>();
    budget_status_rows(
        pool,
        user_id,
        Some(&category_strings),
        month_start,
        month_end,
    )
    .await
}

async fn budget_status_rows(
    pool: &PgPool,
    user_id: Uuid,
    categories: Option<&[String]>,
    month_start: NaiveDate,
    month_end: NaiveDate,
) -> Result<Vec<BudgetStatus>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select b.category::text as category,
               b.monthly_limit_centavos as limit,
               coalesce(sum(t.amount_centavos), 0)::bigint as spent
        from budgets b
        left join transactions t
          on t.user_id = b.user_id
         and t.category = b.category
         and t.kind = 'expense'
         and t.local_date between $3 and $4
        where b.user_id = $1
          and ($2::text[] is null or b.category::text = any($2))
        group by b.category, b.monthly_limit_centavos
        order by b.category
        "#,
    )
    .bind(user_id)
    .bind(categories)
    .bind(month_start)
    .bind(month_end)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let category: String = row.try_get("category")?;
            Ok(BudgetStatus {
                category: coerce_category(category),
                limit: row.try_get("limit")?,
                spent: row.try_get("spent")?,
            })
        })
        .collect()
}

/// Total expense and entry count for an optional category over `[start, end]`.
/// Uses an aggregate `count(*)`, so the count is exact regardless of how many
/// rows match (unlike counting a capped `search_transactions` result).
pub async fn sum_and_count_spend_between(
    pool: &PgPool,
    user_id: Uuid,
    start: NaiveDate,
    end: NaiveDate,
    category: Option<Category>,
) -> Result<(i64, i64), sqlx::Error> {
    let category = category.map(|category| category.as_str().to_string());
    let row = sqlx::query(
        r#"
        select coalesce(sum(amount_centavos), 0)::bigint as total,
               count(*)::bigint as entries
        from transactions
        where user_id = $1 and kind = 'expense' and local_date between $2 and $3
          and ($4::text is null or category = $4::category)
        "#,
    )
    .bind(user_id)
    .bind(start)
    .bind(end)
    .bind(category)
    .fetch_one(pool)
    .await?;
    Ok((row.try_get("total")?, row.try_get("entries")?))
}

pub async fn category_amounts_this_month(
    pool: &PgPool,
    user_id: Uuid,
    category: Category,
    at: DateTime<Utc>,
) -> Result<Vec<i64>, sqlx::Error> {
    let (start, end) = month_range(at, MANILA_OFFSET_MINUTES);
    let rows = sqlx::query(
        r#"
        select amount_centavos
        from transactions
        where user_id = $1 and category = $2::category and kind = 'expense'
          and local_date between $3 and $4
        order by seq asc
        "#,
    )
    .bind(user_id)
    .bind(category.as_str())
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| row.try_get("amount_centavos"))
        .collect()
}

pub async fn get_month_overview(
    pool: &PgPool,
    user_id: Uuid,
    at: DateTime<Utc>,
) -> Result<MonthOverview, sqlx::Error> {
    let (start, end) = month_range(at, MANILA_OFFSET_MINUTES);
    get_month_overview_between(pool, user_id, start, end).await
}

/// Income/expense/net for an explicit inclusive `[start, end]` window. The
/// clock-based [`get_month_overview`] delegates here; read tools call this
/// directly with caller-supplied bounds so the timezone stays explicit.
pub async fn get_month_overview_between(
    pool: &PgPool,
    user_id: Uuid,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<MonthOverview, sqlx::Error> {
    let row = sqlx::query(
        r#"
        select
          coalesce(sum(case when kind = 'income' then amount_centavos else 0 end), 0)::bigint as income,
          coalesce(sum(case when kind = 'expense' then amount_centavos else 0 end), 0)::bigint as expense
        from transactions
        where user_id = $1 and local_date between $2 and $3
        "#,
    )
    .bind(user_id)
    .bind(start)
    .bind(end)
    .fetch_one(pool)
    .await?;
    let income = row.try_get("income")?;
    let expense = row.try_get("expense")?;
    Ok(MonthOverview {
        income,
        expense,
        net: income - expense,
    })
}

pub async fn get_spending_by_category(
    pool: &PgPool,
    user_id: Uuid,
    at: DateTime<Utc>,
) -> Result<Vec<(Category, i64)>, sqlx::Error> {
    let (start, end) = month_range(at, MANILA_OFFSET_MINUTES);
    get_spending_by_category_between(pool, user_id, start, end).await
}

/// Expense totals grouped by category over an explicit inclusive window,
/// largest first. Backs both the clock-based wrapper and the read tools.
pub async fn get_spending_by_category_between(
    pool: &PgPool,
    user_id: Uuid,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<(Category, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select category::text as category, sum(amount_centavos)::bigint as total
        from transactions
        where user_id = $1 and kind = 'expense' and local_date between $2 and $3
        group by category
        order by sum(amount_centavos) desc, category asc
        "#,
    )
    .bind(user_id)
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let category: String = row.try_get("category")?;
            Ok((coerce_category(category), row.try_get("total")?))
        })
        .collect()
}

pub async fn get_recent_transactions(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<TransactionSummaryRow>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select kind::text as kind, amount_centavos, category::text as category, note, local_date
        from transactions
        where user_id = $1
        order by seq desc
        limit $2
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(transaction_summary_from_row).collect()
}

pub async fn search_transactions(
    pool: &PgPool,
    user_id: Uuid,
    opts: &TransactionSearch,
) -> Result<Vec<TransactionSummaryRow>, sqlx::Error> {
    let limit = opts.limit.clamp(1, 50);
    let text = opts
        .text
        .as_deref()
        .map(|value| format!("%{}%", escape_like(value.trim())));
    let category = opts.category.map(|category| category.as_str().to_string());
    let order_by = if opts.by_amount {
        "amount_centavos desc"
    } else {
        "seq desc"
    };
    let sql = format!(
        r#"
        select kind::text as kind, amount_centavos, category::text as category, note, local_date
        from transactions
        where user_id = $1
          and ($2::text is null or note ilike $2 escape '\')
          and ($3::text is null or category = $3::category)
          and ($4::date is null or local_date >= $4)
          and ($5::date is null or local_date <= $5)
          and ($6::bigint is null or amount_centavos >= $6)
          and ($7::bigint is null or amount_centavos <= $7)
          and ($8::text is null or kind = $8::tx_kind)
        order by {order_by}
        limit $9
        "#
    );
    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(text)
        .bind(category)
        .bind(opts.start_date)
        .bind(opts.end_date)
        .bind(opts.min_centavos)
        .bind(opts.max_centavos)
        .bind(opts.kind.as_deref())
        .bind(limit)
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(transaction_summary_from_row).collect()
}

pub async fn list_goals(pool: &PgPool, user_id: Uuid) -> Result<Vec<GoalRow>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        select id, name, target_centavos, saved_centavos, created_at, target_date
        from savings_goals
        where user_id = $1
        order by created_at asc, id asc
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(GoalRow {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                target_centavos: row.try_get("target_centavos")?,
                saved_centavos: row.try_get("saved_centavos")?,
                created_at: row.try_get("created_at")?,
                target_date: row.try_get("target_date")?,
            })
        })
        .collect()
}

fn transaction_from_row(row: sqlx::postgres::PgRow) -> Result<TransactionRow, sqlx::Error> {
    let category: String = row.try_get("category")?;
    let kind: String = row.try_get("kind")?;
    Ok(TransactionRow {
        id: row.try_get("id")?,
        kind: tx_kind_from_db(&kind)?,
        amount_centavos: row.try_get("amount_centavos")?,
        category: coerce_category(category),
        note: row.try_get("note")?,
        goal_id: row.try_get("goal_id")?,
        local_date: row.try_get("local_date")?,
    })
}

fn transaction_summary_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<TransactionSummaryRow, sqlx::Error> {
    let category: String = row.try_get("category")?;
    let kind: String = row.try_get("kind")?;
    Ok(TransactionSummaryRow {
        kind: tx_kind_from_db(&kind)?,
        amount_centavos: row.try_get("amount_centavos")?,
        category: coerce_category(category),
        note: row.try_get("note")?,
        local_date: row.try_get("local_date")?,
    })
}
