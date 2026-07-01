//! Core domain contracts shared across the workspace.
//!
//! These are IO-free value types — the write commands the agent produces
//! ([`WriteIntent`]), the tx/memory/cadence vocabulary, the read-port trait
//! ([`FinanceRead`]) and its result DTOs. They live here (not in `db`) so the
//! AI layer can depend on the domain vocabulary without pulling in the whole
//! persistence crate. The sqlx glue (row decoding, `from_db` parsing, the
//! Postgres-backed `FinanceRead` adapter) stays in `db`.
//!
//! [`WriteIntent`]'s serde representation is persisted in
//! `pending_confirmations.payload_json`; its wire shape is a storage contract
//! and must not change (guarded by a round-trip test in `db`).

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::categories::Category;

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
    /// Stable lowercase DB form (`income`/`expense`).
    #[must_use]
    pub const fn as_db(self) -> &'static str {
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
    /// Stable lowercase DB form (`weekly`/`monthly`).
    #[must_use]
    pub const fn as_db(self) -> &'static str {
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
    /// Stable lowercase label (`user`/`assistant`) for prompts, display, and
    /// the DB form.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
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
    /// Stable lowercase DB form.
    #[must_use]
    pub const fn as_db(self) -> &'static str {
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

// WRITE_INTENT_PLACEHOLDER

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
    /// Consume a pending confirmation as part of this flush. If the row is no
    /// longer `pending` (already consumed by a racing "yes", or this flush is a
    /// superseded retry) the whole transaction is rolled back, so the parked
    /// writes apply exactly once and only when the consume succeeds. Place this
    /// first in the intent list for a "yes" turn.
    ConsumeConfirmation {
        user_id: Uuid,
        id: Uuid,
    },
}

// READ_PORT_PLACEHOLDER

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationTurn {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransactionRow {
    pub id: Uuid,
    pub kind: TxKind,
    pub amount_centavos: i64,
    pub category: Category,
    pub note: Option<String>,
    pub goal_id: Option<Uuid>,
    pub local_date: NaiveDate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransactionSummaryRow {
    pub kind: TxKind,
    pub amount_centavos: i64,
    pub category: Category,
    pub note: Option<String>,
    pub local_date: NaiveDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetStatus {
    pub category: Category,
    pub limit: i64,
    pub spent: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonthOverview {
    pub income: i64,
    pub expense: i64,
    pub net: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalRow {
    pub id: Uuid,
    pub name: String,
    pub target_centavos: i64,
    pub saved_centavos: i64,
    pub created_at: DateTime<Utc>,
    pub target_date: Option<NaiveDate>,
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

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TransactionSearch {
    pub text: Option<String>,
    pub category: Option<Category>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub min_centavos: Option<i64>,
    pub max_centavos: Option<i64>,
    pub kind: Option<String>,
    pub by_amount: bool,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferRow {
    pub amount_centavos: i64,
    pub from_account: Option<String>,
    pub to_account: Option<String>,
    pub note: Option<String>,
    pub local_date: NaiveDate,
}

/// Failure surfaced to the AI layer. Deliberately opaque: it never carries SQL,
/// connection strings, or row contents so tool results cannot leak internals.
/// The `From<sqlx::Error>` conversion lives in `db` (where sqlx is in scope).
#[derive(Debug, Error)]
pub enum ToolReadError {
    #[error("could not read saved records right now")]
    Backend,
}

/// One row in a category-spend breakdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CategorySpend {
    pub category: Category,
    pub total_centavos: i64,
}

/// Read-only finance queries the agent may call. Implementors must not perform
/// writes. Period bounds are inclusive and supplied by the caller.
#[async_trait]
pub trait FinanceRead: Send + Sync {
    /// Income/expense/net totals for the inclusive `[start, end]` window.
    async fn month_overview(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<MonthOverview, ToolReadError>;

    /// Total expense for one category over `[start, end]`, with entry count.
    async fn category_spend(
        &self,
        user_id: Uuid,
        category: Category,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<(i64, i64), ToolReadError>;

    /// Expense totals grouped by category over `[start, end]`, descending.
    async fn spending_by_category(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<CategorySpend>, ToolReadError>;

    /// Sanitized recent transactions matching `opts` (limit clamped by caller).
    async fn search(
        &self,
        user_id: Uuid,
        opts: &TransactionSearch,
    ) -> Result<Vec<TransactionSummaryRow>, ToolReadError>;

    /// Budget status (limit + spent) per category for `[start, end]`.
    async fn budget_statuses(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<BudgetStatus>, ToolReadError>;

    /// Recent account-to-account transfers, optionally filtered to one account.
    async fn transfers(
        &self,
        user_id: Uuid,
        account: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TransferRow>, ToolReadError>;
}
