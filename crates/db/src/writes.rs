use andy_shared::categories::Category;
use andy_shared::memory::{
    compact_memory_content, normalize_memory_content, should_promote_memory_kind,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

const FLUSH_STATEMENT_TIMEOUT_MS: i64 = 30_000;
pub const NOTE_MAX: usize = 500;
pub const NAME_MAX: usize = 100;
pub const LABEL_MAX: usize = 100;
pub const OUTBOUND_CONTENT_MAX: usize = 4000;
pub const PHONE_MAX: usize = 80;
pub const DEDUP_KEY_MAX: usize = 200;
pub const ACCOUNT_MAX: usize = 100;

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

    /// Parse a `tx_kind` value read from the database. Returns a decode error
    /// for any value the enum does not recognize, so a bad DB value surfaces
    /// explicitly instead of being silently coerced.
    pub(crate) fn from_db(value: &str) -> Result<Self, sqlx::Error> {
        match value {
            "income" => Ok(Self::Income),
            "expense" => Ok(Self::Expense),
            other => Err(decode_error("tx_kind", other)),
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

    /// Parse a `cadence` value read from the database.
    pub(crate) fn from_db(value: &str) -> Result<Self, sqlx::Error> {
        match value {
            "weekly" => Ok(Self::Weekly),
            "monthly" => Ok(Self::Monthly),
            other => Err(decode_error("cadence", other)),
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

    /// Parse a `message_role` value read from the database.
    pub(crate) fn from_db(value: &str) -> Result<Self, sqlx::Error> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            other => Err(decode_error("message_role", other)),
        }
    }
}

/// Build an sqlx decode error for an unrecognized enum value read from the DB.
fn decode_error(kind: &str, value: &str) -> sqlx::Error {
    sqlx::Error::Decode(format!("invalid {kind} value in database: {value:?}").into())
}

impl std::fmt::Display for TxKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_db())
    }
}

impl std::fmt::Display for Cadence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_db())
    }
}

impl MessageRole {
    /// Stable lowercase label (`user`/`assistant`) for prompts and display.
    #[must_use]
    pub const fn label(self) -> &'static str {
        self.as_db()
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
        account: Option<String>,
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
    OutboundReply {
        user_id: Uuid,
        phone: String,
        content: String,
        dedup_key: Option<String>,
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
    /// A movement between the user's own accounts. Stored in `transfers`, never
    /// in `transactions`, so it does not count as income or expense.
    Transfer {
        user_id: Uuid,
        amount_centavos: i64,
        from_account: Option<String>,
        to_account: Option<String>,
        note: Option<String>,
        local_date: NaiveDate,
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
    /// Inbound message id carried into transaction inserts (source_message_id)
    /// and ledger_events, so every committed transaction traces back to its
    /// source. `None` for system-initiated flushes (e.g. cron).
    source_message_id: Option<String>,
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
        "set local statement_timeout = {FLUSH_STATEMENT_TIMEOUT_MS}"
    ))
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "set local idle_in_transaction_session_timeout = {FLUSH_STATEMENT_TIMEOUT_MS}"
    ))
    .execute(&mut *tx)
    .await?;

    let mut state = FlushState {
        source_message_id: message_id.map(ToString::to_string),
        ..FlushState::default()
    };
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
            account,
        } => {
            let row = sqlx::query(
                r#"
                insert into transactions
                  (user_id, kind, amount_centavos, category, note, local_date, source_message_id, account)
                values ($1, $2::tx_kind, $3, $4::category, $5, $6, $7, $8)
                returning id
                "#,
            )
            .bind(user_id)
            .bind(kind.as_db())
            .bind(amount_centavos)
            .bind(category.as_str())
            .bind(note.as_deref().map(truncate_note))
            .bind(local_date)
            .bind(state.source_message_id.as_deref())
            .bind(account.as_deref().map(|a| truncate(a, ACCOUNT_MAX)))
            .fetch_one(&mut **tx)
            .await?;
            let tx_id: Uuid = row.try_get("id")?;
            state.last_inserted_tx_id = Some(tx_id);
            let after = json!({
                "kind": kind.as_db(),
                "amount_centavos": amount_centavos,
                "category": category.as_str(),
                "local_date": local_date.to_string(),
            });
            record_ledger_event(
                tx,
                *user_id,
                Some(tx_id),
                "tx_create",
                None,
                Some(after),
                state.source_message_id.as_deref(),
            )
            .await?;
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
                  (user_id, kind, amount_centavos, category, goal_id, local_date, source_message_id)
                values ($1, 'expense', $2, 'Savings/Goals', $3, $4, $5)
                returning id
                "#,
            )
            .bind(user_id)
            .bind(amount_centavos)
            .bind(goal_id)
            .bind(local_date)
            .bind(state.source_message_id.as_deref())
            .fetch_one(&mut **tx)
            .await?;
            let tx_id: Uuid = row.try_get("id")?;
            state.last_inserted_tx_id = Some(tx_id);
            let new_balance = sqlx::query(
                r#"
                update savings_goals
                set saved_centavos = saved_centavos + $3, updated_at = now()
                where id = $1 and user_id = $2
                returning saved_centavos
                "#,
            )
            .bind(goal_id)
            .bind(user_id)
            .bind(amount_centavos)
            .fetch_optional(&mut **tx)
            .await?
            .map(|r| r.try_get::<i64, _>("saved_centavos"))
            .transpose()?;
            let after = json!({
                "kind": "expense",
                "amount_centavos": amount_centavos,
                "category": "Savings/Goals",
                "goal_id": goal_id,
                "goal_saved_centavos": new_balance,
                "local_date": local_date.to_string(),
            });
            record_ledger_event(
                tx,
                *user_id,
                Some(tx_id),
                "tx_create",
                None,
                Some(after),
                state.source_message_id.as_deref(),
            )
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
                delete_transaction(tx, *user_id, target_id, state.source_message_id.as_deref())
                    .await?;
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
                edit_transaction(
                    tx,
                    *user_id,
                    target_id,
                    *amount_centavos,
                    *category,
                    note,
                    state.source_message_id.as_deref(),
                )
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
        WriteIntent::OutboundReply {
            user_id,
            phone,
            content,
            dedup_key,
        } => {
            save_outbound_reply_in_tx(tx, *user_id, phone, content, dedup_key.as_deref()).await?;
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
        WriteIntent::Transfer {
            user_id,
            amount_centavos,
            from_account,
            to_account,
            note,
            local_date,
        } => {
            sqlx::query(
                r#"
                insert into transfers
                  (user_id, amount_centavos, from_account, to_account, note, local_date, source_message_id)
                values ($1, $2, $3, $4, $5, $6, $7)
                "#,
            )
            .bind(user_id)
            .bind(amount_centavos)
            .bind(from_account.as_deref().map(|a| truncate(a, ACCOUNT_MAX)))
            .bind(to_account.as_deref().map(|a| truncate(a, ACCOUNT_MAX)))
            .bind(note.as_deref().map(truncate_note))
            .bind(local_date)
            .bind(state.source_message_id.as_deref())
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

async fn delete_transaction(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    target_id: Uuid,
    source_message_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query(
        r#"
        select amount_centavos, category::text as category, kind::text as kind,
               goal_id, local_date
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
    let category: String = row.try_get("category")?;
    let kind: String = row.try_get("kind")?;
    let local_date: chrono::NaiveDate = row.try_get("local_date")?;
    let mut goal_balance: Option<i64> = None;
    if let Some(goal_id) = goal_id {
        goal_balance = sqlx::query(
            r#"
            update savings_goals
            set saved_centavos = saved_centavos - $3, updated_at = now()
            where id = $1 and user_id = $2
            returning saved_centavos
            "#,
        )
        .bind(goal_id)
        .bind(user_id)
        .bind(amount_centavos)
        .fetch_optional(&mut **tx)
        .await?
        .map(|r| r.try_get::<i64, _>("saved_centavos"))
        .transpose()?;
    }
    sqlx::query("delete from transactions where id = $1 and user_id = $2")
        .bind(target_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    let before = json!({
        "kind": kind,
        "amount_centavos": amount_centavos,
        "category": category,
        "goal_id": goal_id,
        "goal_saved_centavos": goal_balance,
        "local_date": local_date.to_string(),
    });
    record_ledger_event(
        tx,
        user_id,
        Some(target_id),
        "tx_delete",
        Some(before),
        None,
        source_message_id,
    )
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
    source_message_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query(
        r#"
        select amount_centavos, category::text as category, goal_id
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
    let old_category: String = row.try_get("category")?;
    let goal_id: Option<Uuid> = row.try_get("goal_id")?;
    let mut goal_balance: Option<i64> = None;
    if let Some(goal_id) = goal_id
        && let Some(new_amount) = amount_centavos
        && new_amount != old_amount
    {
        goal_balance = sqlx::query(
            r#"
            update savings_goals
            set saved_centavos = saved_centavos + $3, updated_at = now()
            where id = $1 and user_id = $2
            returning saved_centavos
            "#,
        )
        .bind(goal_id)
        .bind(user_id)
        .bind(new_amount - old_amount)
        .fetch_optional(&mut **tx)
        .await?
        .map(|r| r.try_get::<i64, _>("saved_centavos"))
        .transpose()?;
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

    let after_category = effective_category
        .map(|c| c.as_str().to_string())
        .unwrap_or_else(|| old_category.clone());
    let before = json!({
        "amount_centavos": old_amount,
        "category": old_category,
        "goal_id": goal_id,
    });
    let after = json!({
        "amount_centavos": amount_centavos.unwrap_or(old_amount),
        "category": after_category,
        "goal_id": goal_id,
        "goal_saved_centavos": goal_balance,
    });
    record_ledger_event(
        tx,
        user_id,
        Some(target_id),
        "tx_edit",
        Some(before),
        Some(after),
        source_message_id,
    )
    .await?;
    Ok(())
}

/// Append one row to the ledger audit trail. before/after are compact,
/// sanitized JSON snapshots — never raw notes or provider data.
async fn record_ledger_event(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    transaction_id: Option<Uuid>,
    event_type: &str,
    before: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
    source_message_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        insert into ledger_events
          (user_id, transaction_id, event_type, before, after, source_message_id)
        values ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(transaction_id)
    .bind(event_type)
    .bind(before)
    .bind(after)
    .bind(source_message_id)
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

async fn save_outbound_reply_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    phone: &str,
    content: &str,
    dedup_key: Option<&str>,
) -> Result<(), sqlx::Error> {
    let content = truncate(content.trim(), OUTBOUND_CONTENT_MAX);
    let phone = truncate(phone.trim(), PHONE_MAX);
    let dedup_key = dedup_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate(value, DEDUP_KEY_MAX));
    if content.is_empty() || phone.is_empty() {
        return Ok(());
    }

    sqlx::query(
        r#"
        insert into outbound_messages (user_id, phone, content, dedup_key)
        values ($1, $2, $3, $4)
        on conflict (dedup_key) where dedup_key is not null do update
          set phone = excluded.phone,
              content = excluded.content,
              status = case
                when outbound_messages.status = 'sent' then outbound_messages.status
                else 'pending'
              end,
              next_attempt_at = case
                when outbound_messages.status = 'sent' then outbound_messages.next_attempt_at
                else now()
              end,
              updated_at = now()
        "#,
    )
    .bind(user_id)
    .bind(phone)
    .bind(content)
    .bind(dedup_key)
    .execute(&mut **tx)
    .await?;
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
    fn truncate_clips_to_char_boundary() {
        assert_eq!(super::truncate("hello", 3), "hel");
        assert_eq!(super::truncate("hi", 5), "hi");
    }

    #[test]
    fn enum_from_db_parses_known_and_rejects_unknown() {
        assert_eq!(TxKind::from_db("income").unwrap(), TxKind::Income);
        assert_eq!(Cadence::from_db("weekly").unwrap(), Cadence::Weekly);
        assert_eq!(
            MessageRole::from_db("assistant").unwrap(),
            MessageRole::Assistant
        );
        assert!(TxKind::from_db("bogus").is_err());
        assert!(Cadence::from_db("daily").is_err());
        assert!(MessageRole::from_db("system").is_err());
    }

    #[test]
    fn enum_display_round_trips_db_form() {
        assert_eq!(TxKind::Expense.to_string(), "expense");
        assert_eq!(Cadence::Monthly.to_string(), "monthly");
        assert_eq!(MessageRole::User.label(), "user");
    }
}
