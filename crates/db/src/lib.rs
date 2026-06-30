#![forbid(unsafe_code)]

pub mod client;
pub mod confirmations;
pub mod migrations;
pub mod ops;
pub mod queries;
pub mod ratelimit;
pub mod read;
pub mod writes;

pub use client::{connect_pool, is_pooler_url};
pub use confirmations::{
    PendingConfirmation, cancel_pending_confirmations, consume_confirmation,
    latest_pending_confirmation, reap_pending_confirmations, save_pending_confirmation,
};
pub use ops::{
    InsightSummary, MemoryRow, OutboundMessageRow, RecurringRow, add_recurring,
    claim_due_outbound_messages, claim_outbound_by_dedup_key, claim_reminder, due_recurring_today,
    find_recurring_by_label, find_recurring_matches, forget_memory, get_insights,
    has_summary_for_week, learn_habit, list_memories, list_recurring, mark_outbound_failed,
    mark_outbound_sent, reap_messages, reap_nudges, reap_processed_messages, reap_summary_runs,
    reconcile_goal_balances, record_nudge, record_summary, save_memory, top_habits,
};
pub use queries::{
    BudgetStatus, ClaimResult, ConversationTurn, GoalRow, MonthOverview, TransactionRow,
    TransactionSearch, TransactionSummaryRow, TransferRow, budget_statuses, budget_statuses_for,
    category_amounts_this_month, claim_slot, find_goal_by_name, find_goals_by_name,
    find_recent_duplicate, get_month_overview, get_month_overview_between, get_recent_transactions,
    get_spending_by_category, get_spending_by_category_between, last_transaction, list_goals,
    recent_turns, resolve_user_id, search_transactions, search_transfers, sum_by_category,
    sum_spend_between,
};
pub use ratelimit::{RateDecision, check_and_increment, reap_inbound_rate_limits};
pub use read::{CategorySpend, FinanceRead, PgFinanceRead, ToolReadError};
pub use writes::{FlushResult, RecurringInput, WriteIntent, flush_writes};

#[cfg(all(test, feature = "db-integration"))]
mod integration_tests;
