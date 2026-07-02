#![forbid(unsafe_code)]

pub mod client;
pub mod confirmations;
pub mod migrations;
pub mod ops;
pub mod queries;
pub mod ratelimit;
pub mod read;
mod sql;
pub mod writes;

pub use client::{connect_pool, is_pooler_url};
pub use confirmations::{
    PendingConfirmation, cancel_pending_confirmations, consume_confirmation,
    latest_pending_confirmation, reap_pending_confirmations, save_pending_confirmation,
};
pub use ops::{
    MemoryRow, OutboundMessageRow, claim_due_outbound_messages, claim_outbound_by_dedup_key,
    claim_reminder, due_recurring_today, has_summary_for_week, list_memories, list_recurring,
    mark_outbound_failed, mark_outbound_sent, reap_messages, reap_nudges, reap_processed_messages,
    reap_summary_runs, reconcile_goal_balances, record_nudge, record_summary,
};
pub use queries::{
    ClaimResult, budget_statuses, budget_statuses_for, category_amounts_this_month, claim_slot,
    get_month_overview, get_month_overview_between, get_recent_transactions,
    get_spending_by_category, get_spending_by_category_between, last_transaction, list_goals,
    recent_turns, resolve_user_id, search_transactions, search_transfers,
};
pub use ratelimit::{RateDecision, check_and_increment, reap_inbound_rate_limits};
pub use read::PgFinanceRead;
pub use writes::{FlushResult, flush_writes};

// Domain contracts (moved to andy_shared::domain) re-exported so existing
// `andy_db::{WriteIntent, FinanceRead, GoalRow, ...}` import paths keep working
// for api, xtask, and db-internal code without change.
pub use andy_shared::domain::{
    BudgetStatus, Cadence, CategorySpend, ConversationTurn, FinanceRead, GoalRow, MemoryKind,
    MessageRole, MonthOverview, RecurringInput, RecurringRow, ToolReadError, TransactionRow,
    TransactionSearch, TransactionSummaryRow, TransferRow, TxKind, WriteIntent,
};

#[cfg(all(test, feature = "db-integration"))]
mod integration_tests;
