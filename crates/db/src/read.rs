//! Postgres-backed adapter for the read-only finance port.
//!
//! The [`FinanceRead`] trait, its result DTOs, [`CategorySpend`], and
//! [`ToolReadError`] are pure domain contracts defined in
//! `andy_shared::domain`. This module keeps only the sqlx-coupled pieces: the
//! `From<sqlx::Error>` conversion (which needs sqlx in scope) and the
//! Postgres-backed [`PgFinanceRead`] adapter, so the AI crate can depend on the
//! port without any route/pool plumbing and without write capability.

use andy_shared::categories::Category;
use andy_shared::domain::{
    BudgetStatus, CategorySpend, FinanceRead, MonthOverview, ToolReadError, TransactionSearch,
    TransactionSummaryRow, TransferRow,
};
use async_trait::async_trait;
use chrono::NaiveDate;
use sqlx::PgPool;
use uuid::Uuid;

use crate::queries::{
    budget_statuses_for, get_month_overview_between, get_spending_by_category_between,
    search_transactions, search_transfers, sum_and_count_spend_between,
};

/// Map any sqlx failure to the opaque [`ToolReadError::Backend`]. Defined here
/// (not in `shared`) because it requires sqlx in scope, and it intentionally
/// drops the underlying error so backend detail never reaches the model.
pub(crate) fn read_backend_error(_: sqlx::Error) -> ToolReadError {
    ToolReadError::Backend
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
        get_month_overview_between(&self.pool, user_id, start, end)
            .await
            .map_err(read_backend_error)
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
        sum_and_count_spend_between(&self.pool, user_id, start, end, Some(category))
            .await
            .map_err(read_backend_error)
    }

    async fn spending_by_category(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<CategorySpend>, ToolReadError> {
        let rows = get_spending_by_category_between(&self.pool, user_id, start, end)
            .await
            .map_err(read_backend_error)?;
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
        search_transactions(&self.pool, user_id, opts)
            .await
            .map_err(read_backend_error)
    }

    async fn budget_statuses(
        &self,
        user_id: Uuid,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<BudgetStatus>, ToolReadError> {
        let categories = Category::ALL.to_vec();
        budget_statuses_for(&self.pool, user_id, &categories, start, end)
            .await
            .map_err(read_backend_error)
    }

    async fn transfers(
        &self,
        user_id: Uuid,
        account: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TransferRow>, ToolReadError> {
        search_transfers(&self.pool, user_id, account, limit)
            .await
            .map_err(read_backend_error)
    }
}
