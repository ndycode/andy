//! Read-only finance access for the AI layer.
//!
//! The agent answers analytics questions ("how much on food this month?")
//! against saved records rather than a small prompt snapshot. This module
//! exposes a narrow [`FinanceRead`] trait plus a Postgres-backed adapter so the
//! AI crate can query without depending on route/pool plumbing and without any
//! write capability — read tools must never mutate the ledger.
//!
//! All date math is passed in explicitly (no clock or env reads here) so the
//! caller owns the timezone and results stay deterministic in tests.

use andy_shared::categories::Category;
use async_trait::async_trait;
use chrono::NaiveDate;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::queries::{
    BudgetStatus, MonthOverview, TransactionSearch, TransactionSummaryRow, TransferRow,
    budget_statuses_for, get_month_overview_between, get_spending_by_category_between,
    search_transactions, search_transfers, sum_and_count_spend_between,
};

/// Failure surfaced to the AI layer. Deliberately opaque: it never carries SQL,
/// connection strings, or row contents so tool results cannot leak internals.
#[derive(Debug, Error)]
pub enum ToolReadError {
    #[error("could not read saved records right now")]
    Backend,
}

impl From<sqlx::Error> for ToolReadError {
    fn from(_: sqlx::Error) -> Self {
        // Drop the underlying error on purpose; the model never needs (and must
        // not relay) backend detail.
        Self::Backend
    }
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

/// Postgres-backed [`FinanceRead`]. Wraps a clone of the request pool.
#[derive(Debug, Clone)]
pub struct PgFinanceRead {
    pool: PgPool,
}

impl PgFinanceRead {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl FinanceRead for PgFinanceRead {
    async fn month_overview(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<MonthOverview, ToolReadError> {
        Ok(get_month_overview_between(&self.pool, user_id, start, end).await?)
    }

    async fn category_spend(
        &self,
        user_id: Uuid,
        category: Category,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<(i64, i64), ToolReadError> {
        // Aggregate count(*), not a capped search, so the entry count is exact
        // even when a category has more than the search limit of matches.
        Ok(sum_and_count_spend_between(&self.pool, user_id, start, end, Some(category)).await?)
    }

    async fn spending_by_category(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<CategorySpend>, ToolReadError> {
        let rows = get_spending_by_category_between(&self.pool, user_id, start, end).await?;
        Ok(rows
            .into_iter()
            .map(|(category, total_centavos)| CategorySpend {
                category,
                total_centavos,
            })
            .collect())
    }

    async fn search(
        &self,
        user_id: Uuid,
        opts: &TransactionSearch,
    ) -> Result<Vec<TransactionSummaryRow>, ToolReadError> {
        Ok(search_transactions(&self.pool, user_id, opts).await?)
    }

    async fn budget_statuses(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<BudgetStatus>, ToolReadError> {
        let categories = Category::ALL.to_vec();
        Ok(budget_statuses_for(&self.pool, user_id, &categories, start, end).await?)
    }

    async fn transfers(
        &self,
        user_id: Uuid,
        account: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TransferRow>, ToolReadError> {
        Ok(search_transfers(&self.pool, user_id, account, limit).await?)
    }
}
