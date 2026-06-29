#![forbid(unsafe_code)]

pub mod client;
pub mod migrations;
pub mod ops;
pub mod queries;
pub mod writes;

pub use client::{connect_pool, is_pooler_url};
pub use ops::{
    InsightSummary, MemoryRow, RecurringRow, add_recurring, claim_reminder, due_recurring_today,
    find_recurring_by_label, find_recurring_matches, forget_memory, get_insights,
    has_summary_for_week, learn_habit, list_memories, list_recurring, reap_messages, reap_nudges,
    reap_processed_messages, reap_summary_runs, recall_memories, reconcile_goal_balances,
    record_nudge, record_summary, save_memory, top_habits,
};
pub use queries::{
    BudgetStatus, ClaimResult, ConversationTurn, GoalRow, MonthOverview, TransactionRow,
    TransactionSearch, TransactionSummaryRow, budget_statuses, budget_statuses_for,
    category_amounts_this_month, claim_slot, find_goal_by_name, find_goals_by_name,
    find_recent_duplicate, get_month_overview, get_recent_transactions, get_spending_by_category,
    last_transaction, list_goals, recent_turns, resolve_user_id, search_transactions,
    sum_by_category, sum_spend_between,
};
pub use writes::{FlushResult, RecurringInput, WriteIntent, flush_writes};
