use andy_shared::categories::Category;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

const FLUSH_STATEMENT_TIMEOUT_MS: i64 = 30_000;
pub const NOTE_MAX: usize = 500;
pub const NAME_MAX: usize = 100;
pub const LABEL_MAX: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurringInput {
    pub label: String,
    pub kind: TxKind,
    pub amount_centavos: i64,
    pub category: Category,
    pub cadence: Cadence,
    pub day_of_month: Option<i64>,
    pub day_of_week: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TxKind {
    Income,
    Expense,
}

impl TxKind {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Expense => "expense",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Cadence {
    Weekly,
    Monthly,
}

impl Cadence {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageRole {
    User,
    Assistant,
}

impl MessageRole {
    const fn as_db(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WriteIntent {
    Transaction {
        kind: TxKind,
        user_id: Uuid,
        amount_centavos: i64,
        category: Category,
        note: Option<String>,
        local_date: NaiveDate,
    },
    GoalContribution {
        user_id: Uuid,
        goal_id: Uuid,
        amount_centavos: i64,
        local_date: NaiveDate,
    },
    DeleteLast {
        user_id: Uuid,
        target_id: Option<Uuid>,
        target_same_turn: bool,
    },
    EditLast {
        user_id: Uuid,
        target_id: Option<Uuid>,
        target_same_turn: bool,
        amount_centavos: Option<i64>,
        category: Option<Category>,
        note: Option<String>,
    },
    CreateGoal {
        user_id: Uuid,
        name: String,
        target_centavos: i64,
        target_date: Option<NaiveDate>,
    },
    SetBudget {
        user_id: Uuid,
        category: Category,
        monthly_limit_centavos: i64,
    },
    RemoveBudget {
        user_id: Uuid,
        category: Category,
    },
    EditGoal {
        user_id: Uuid,
        goal_id: Uuid,
        name: Option<String>,
        target_centavos: Option<i64>,
        target_date: Option<Option<NaiveDate>>,
    },
    DeleteGoal {
        user_id: Uuid,
        goal_id: Uuid,
    },
    SaveMemory {
        user_id: Uuid,
        content: String,
        kind: MemoryKind,
    },
    ForgetMemory {
        user_id: Uuid,
        query: String,
    },
    SaveTurn {
        user_id: Uuid,
        role: MessageRole,
        content: String,
    },
    AddRecurring {
        user_id: Uuid,
        recurring: RecurringInput,
    },
    RemoveRecurring {
        user_id: Uuid,
        query: String,
    },
    EditRecurring {
        user_id: Uuid,
        query: String,
        amount_centavos: Option<i64>,
        category: Option<Category>,
        cadence: Option<Cadence>,
        day_of_month: Option<Option<i64>>,
        day_of_week: Option<Option<i64>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryKind {
    Fact,
    Preference,
    Payday,
    Goal,
    Person,
    Other,
}

impl MemoryKind {
    const fn as_db(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Payday => "payday",
            Self::Goal => "goal",
            Self::Person => "person",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushResult {
    Committed,
    Superseded,
}

#[derive(Default)]
struct FlushState {
    last_inserted_tx_id: Option<Uuid>,
}

pub async fn flush_writes(
    pool: &PgPool,
    message_id: Option<&str>,
    intents: &[WriteIntent],
) -> Result<FlushResult, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("set local transaction isolation level read committed")
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!(
        "set local statement_timeout = {FLUSH_STATEMENT_TIMEOUT_MS};
         set local idle_in_transaction_session_timeout = {FLUSH_STATEMENT_TIMEOUT_MS};"
    ))
    .execute(&mut *tx)
    .await?;

    let mut state = FlushState::default();
    for intent in intents {
        apply_write_intent(&mut tx, intent, &mut state).await?;
    }

    if let Some(message_id) = message_id {
        let completed = sqlx::query(
            r#"
            insert into processed_messages (message_id, status, completed_at)
            values ($1, 'completed', now())
            on conflict (message_id) do update
              set status = 'completed', completed_at = now()
              where processed_messages.status = 'claimed'
            returning message_id
            "#,
        )
        .bind(message_id)
        .fetch_optional(&mut *tx)
        .await?;
        if completed.is_none() {
            tx.rollback().await?;
            return Ok(FlushResult::Superseded);
        }
    }

    tx.commit().await?;
    Ok(FlushResult::Committed)
}

async fn apply_write_intent(
    tx: &mut Transaction<'_, Postgres>,
    intent: &WriteIntent,
    state: &mut FlushState,
) -> Result<(), sqlx::Error> {
    match intent {
        WriteIntent::Transaction {
            kind,
            user_id,
            amount_centavos,
            category,
            note,
            local_date,
        } => {
            let row = sqlx::query(
                r#"
                insert into transactions
                  (user_id, kind, amount_centavos, category, note, local_date)
                values ($1, $2::tx_kind, $3, $4::category, $5, $6)
                returning id
                "#,
            )
            .bind(user_id)
            .bind(kind.as_db())
            .bind(amount_centavos)
            .bind(category.as_str())
            .bind(note.as_deref().map(truncate_note))
            .bind(local_date)
            .fetch_one(&mut **tx)
            .await?;
            state.last_inserted_tx_id = Some(row.try_get("id")?);
        }
        WriteIntent::GoalContribution {
            user_id,
            goal_id,
            amount_centavos,
            local_date,
        } => {
            let row = sqlx::query(
                r#"
                insert into transactions
                  (user_id, kind, amount_centavos, category, goal_id, local_date)
                values ($1, 'expense', $2, 'Savings/Goals', $3, $4)
                returning id
                "#,
            )
            .bind(user_id)
            .bind(amount_centavos)
            .bind(goal_id)
            .bind(local_date)
            .fetch_one(&mut **tx)
            .await?;
            state.last_inserted_tx_id = Some(row.try_get("id")?);
            sqlx::query(
                r#"
                update savings_goals
                set saved_centavos = saved_centavos + $3, updated_at = now()
                where id = $1 and user_id = $2
                "#,
            )
            .bind(goal_id)
            .bind(user_id)
            .bind(amount_centavos)
            .execute(&mut **tx)
            .await?;
        }
        WriteIntent::DeleteLast {
            user_id,
            target_id,
            target_same_turn,
        } => {
            let target_id = if *target_same_turn {
                state.last_inserted_tx_id
            } else {
                *target_id
            };
            if let Some(target_id) = target_id {
                delete_transaction(tx, *user_id, target_id).await?;
                if *target_same_turn {
                    state.last_inserted_tx_id = None;
                }
            }
        }
        WriteIntent::EditLast {
            user_id,
            target_id,
            target_same_turn,
            amount_centavos,
            category,
            note,
        } => {
            let target_id = if *target_same_turn {
                state.last_inserted_tx_id
            } else {
                *target_id
            };
            if let Some(target_id) = target_id {
                edit_transaction(tx, *user_id, target_id, *amount_centavos, *category, note)
                    .await?;
            }
        }
        WriteIntent::CreateGoal {
            user_id,
            name,
            target_centavos,
            target_date,
        } => {
            sqlx::query(
                r#"
                insert into savings_goals (user_id, name, target_centavos, target_date)
                values ($1, $2, $3, $4)
                on conflict (user_id, lower(name)) do nothing
                "#,
            )
            .bind(user_id)
            .bind(truncate(name, NAME_MAX))
            .bind(target_centavos)
            .bind(target_date)
            .execute(&mut **tx)
            .await?;
        }
        WriteIntent::SetBudget {
            user_id,
            category,
            monthly_limit_centavos,
        } => {
            sqlx::query(
                r#"
                insert into budgets (user_id, category, monthly_limit_centavos)
                values ($1, $2::category, $3)
                on conflict (user_id, category) do update
                  set monthly_limit_centavos = excluded.monthly_limit_centavos,
                      updated_at = now()
                "#,
            )
            .bind(user_id)
            .bind(category.as_str())
            .bind(monthly_limit_centavos)
            .execute(&mut **tx)
            .await?;
        }
        WriteIntent::RemoveBudget { user_id, category } => {
            sqlx::query("delete from budgets where user_id = $1 and category = $2::category")
                .bind(user_id)
                .bind(category.as_str())
                .execute(&mut **tx)
                .await?;
        }
        WriteIntent::EditGoal {
            user_id,
            goal_id,
            name,
            target_centavos,
            target_date,
        } => {
            if name.is_some() || target_centavos.is_some() || target_date.is_some() {
                let truncated_name = name.as_deref().map(|value| truncate(value, NAME_MAX));
                sqlx::query(
                    r#"
                    update savings_goals
                    set name = case when $3 then $4 else name end,
                        target_centavos = coalesce($5, target_centavos),
                        target_date = case when $6 then $7 else target_date end,
                        updated_at = now()
                    where id = $1 and user_id = $2
                    "#,
                )
                .bind(goal_id)
                .bind(user_id)
                .bind(name.is_some())
                .bind(truncated_name)
                .bind(target_centavos)
                .bind(target_date.is_some())
                .bind(target_date.unwrap_or(None))
                .execute(&mut **tx)
                .await?;
            }
        }
        WriteIntent::DeleteGoal { user_id, goal_id } => {
            sqlx::query(
                r#"
                update transactions
                set goal_id = null, updated_at = now()
                where goal_id = $1 and user_id = $2
                "#,
            )
            .bind(goal_id)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
            sqlx::query("delete from savings_goals where id = $1 and user_id = $2")
                .bind(goal_id)
                .bind(user_id)
                .execute(&mut **tx)
                .await?;
        }
        WriteIntent::SaveMemory {
            user_id,
            content,
            kind,
        } => {
            save_memory_in_tx(tx, *user_id, content, *kind).await?;
        }
        WriteIntent::ForgetMemory { user_id, query } => {
            forget_memory_in_tx(tx, *user_id, query).await?;
        }
        WriteIntent::SaveTurn {
            user_id,
            role,
            content,
        } => {
            sqlx::query(
                r#"
                insert into messages (user_id, role, content)
                values ($1, $2::message_role, $3)
                "#,
            )
            .bind(user_id)
            .bind(role.as_db())
            .bind(truncate(content, 4000))
            .execute(&mut **tx)
            .await?;
        }
        WriteIntent::AddRecurring { user_id, recurring } => {
            sqlx::query(
                r#"
                insert into recurring_items
                  (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
                values ($1, $2, $3::tx_kind, $4, $5::category, $6::cadence, $7, $8)
                on conflict (user_id, lower(label)) do update
                  set kind = excluded.kind,
                      amount_centavos = excluded.amount_centavos,
                      category = excluded.category,
                      cadence = excluded.cadence,
                      day_of_month = excluded.day_of_month,
                      day_of_week = excluded.day_of_week,
                      updated_at = now()
                "#,
            )
            .bind(user_id)
            .bind(truncate(&recurring.label, LABEL_MAX))
            .bind(recurring.kind.as_db())
            .bind(recurring.amount_centavos)
            .bind(recurring.category.as_str())
            .bind(recurring.cadence.as_db())
            .bind(recurring.day_of_month)
            .bind(recurring.day_of_week)
            .execute(&mut **tx)
            .await?;
        }
        WriteIntent::RemoveRecurring { user_id, query } => {
            if let Some(target_id) = recurring_target_id(tx, *user_id, query).await? {
                sqlx::query("delete from recurring_items where id = $1 and user_id = $2")
                    .bind(target_id)
                    .bind(user_id)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        WriteIntent::EditRecurring {
            user_id,
            query,
            amount_centavos,
            category,
            cadence,
            day_of_month,
            day_of_week,
        } => {
            if amount_centavos.is_none()
                && category.is_none()
                && cadence.is_none()
                && day_of_month.is_none()
                && day_of_week.is_none()
            {
                return Ok(());
            }
            if let Some(target_id) = recurring_target_id(tx, *user_id, query).await? {
                sqlx::query(
                    r#"
                    update recurring_items
                    set amount_centavos = coalesce($3, amount_centavos),
                        category = case when $4::category is null then category else $4::category end,
                        cadence = case when $5::cadence is null then cadence else $5::cadence end,
                        day_of_month = case when $6 then $7 else day_of_month end,
                        day_of_week = case when $8 then $9 else day_of_week end,
                        updated_at = now()
                    where id = $1 and user_id = $2
                    "#,
                )
                .bind(target_id)
                .bind(user_id)
                .bind(amount_centavos)
                .bind(category.map(|value| value.as_str()))
                .bind(cadence.map(Cadence::as_db))
                .bind(day_of_month.is_some())
                .bind(day_of_month.unwrap_or(None))
                .bind(day_of_week.is_some())
                .bind(day_of_week.unwrap_or(None))
                .execute(&mut **tx)
                .await?;
            }
        }
    }
    Ok(())
}

async fn delete_transaction(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    target_id: Uuid,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query(
        r#"
        select amount_centavos, goal_id
        from transactions
        where id = $1 and user_id = $2
        "#,
    )
    .bind(target_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let amount_centavos: i64 = row.try_get("amount_centavos")?;
    let goal_id: Option<Uuid> = row.try_get("goal_id")?;
    if let Some(goal_id) = goal_id {
        sqlx::query(
            r#"
            update savings_goals
            set saved_centavos = saved_centavos - $3, updated_at = now()
            where id = $1 and user_id = $2
            "#,
        )
        .bind(goal_id)
        .bind(user_id)
        .bind(amount_centavos)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query("delete from transactions where id = $1 and user_id = $2")
        .bind(target_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn edit_transaction(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    target_id: Uuid,
    amount_centavos: Option<i64>,
    category: Option<Category>,
    note: &Option<String>,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query(
        r#"
        select amount_centavos, goal_id
        from transactions
        where id = $1 and user_id = $2
        "#,
    )
    .bind(target_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let old_amount: i64 = row.try_get("amount_centavos")?;
    let goal_id: Option<Uuid> = row.try_get("goal_id")?;
    if let Some(goal_id) = goal_id
        && let Some(new_amount) = amount_centavos
        && new_amount != old_amount
    {
        sqlx::query(
            r#"
            update savings_goals
            set saved_centavos = saved_centavos + $3, updated_at = now()
            where id = $1 and user_id = $2
            "#,
        )
        .bind(goal_id)
        .bind(user_id)
        .bind(new_amount - old_amount)
        .execute(&mut **tx)
        .await?;
    }

    let effective_category = category.filter(|_| goal_id.is_none());
    if amount_centavos.is_none() && effective_category.is_none() && note.is_none() {
        return Ok(());
    }
    let note_value = note.as_deref().map(truncate_note);
    sqlx::query(
        r#"
        update transactions
        set amount_centavos = coalesce($3, amount_centavos),
            category = case when $4::category is null then category else $4::category end,
            note = case when $5 then $6 else note end,
            updated_at = now()
        where id = $1 and user_id = $2
        "#,
    )
    .bind(target_id)
    .bind(user_id)
    .bind(amount_centavos)
    .bind(effective_category.map(|value| value.as_str()))
    .bind(note.is_some())
    .bind(note_value)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn save_memory_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    content: &str,
    kind: MemoryKind,
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
        order by created_at desc
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(&normalized)
    .bind(&compact)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(existing) = existing {
        let id: Uuid = existing.try_get("id")?;
        let current_kind: String = existing.try_get("kind")?;
        if should_promote_memory_kind(&current_kind, kind.as_db()) {
            sqlx::query(
                "update memories set kind = $3::memory_kind where id = $1 and user_id = $2",
            )
            .bind(id)
            .bind(user_id)
            .bind(kind.as_db())
            .execute(&mut **tx)
            .await?;
        }
        return Ok(());
    }

    sqlx::query("insert into memories (user_id, content, kind) values ($1, $2, $3::memory_kind)")
        .bind(user_id)
        .bind(trimmed)
        .bind(kind.as_db())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn forget_memory_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    query: &str,
) -> Result<(), sqlx::Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(());
    }
    let normalized = normalize_memory_content(query);
    let compact = compact_memory_content(query);
    if compact.is_empty() {
        return Ok(());
    }

    let exact = sqlx::query(
        r#"
        select id
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
    .fetch_optional(&mut **tx)
    .await?;

    let hit = if exact.is_some() {
        exact
    } else {
        sqlx::query(
            r#"
            select id
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
        .fetch_optional(&mut **tx)
        .await?
    };

    if let Some(hit) = hit {
        let id: Uuid = hit.try_get("id")?;
        sqlx::query("delete from memories where id = $1 and user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn recurring_target_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    query: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(None);
    }
    let exact = sqlx::query(
        r#"
        select id
        from recurring_items
        where user_id = $1 and lower(label) = lower($2)
        order by created_at, id
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(query)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = exact {
        return row.try_get("id").map(Some);
    }

    let matches = sqlx::query(
        r#"
        select id
        from recurring_items
        where user_id = $1 and lower(label) like lower($2) escape '\'
        order by created_at, id
        limit 2
        "#,
    )
    .bind(user_id)
    .bind(format!("%{}%", escape_like(query)))
    .fetch_all(&mut **tx)
    .await?;
    if matches.len() == 1 {
        matches[0].try_get("id").map(Some)
    } else {
        Ok(None)
    }
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn truncate_note(value: &str) -> String {
    truncate(value, NOTE_MAX)
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
    fn memory_normalization_matches_punctuated_duplicates() {
        assert_eq!(
            normalize_memory_content("  Payday: every Friday! "),
            "payday every friday"
        );
        assert_eq!(compact_memory_content("Pay day"), "payday");
    }

    #[test]
    fn memory_kind_promotion_keeps_stronger_kind() {
        assert!(should_promote_memory_kind("other", "payday"));
        assert!(!should_promote_memory_kind("payday", "fact"));
    }
}
