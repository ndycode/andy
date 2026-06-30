use andy_shared::categories::Category;
use chrono::{Duration, TimeZone, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    ClaimResult, FinanceRead, FlushResult, PgFinanceRead, RecurringInput, TransactionSearch,
    WriteIntent, cancel_pending_confirmations, claim_outbound_by_dedup_key, claim_reminder,
    claim_slot, consume_confirmation, due_recurring_today, find_goal_by_name, flush_writes,
    latest_pending_confirmation, list_goals, list_memories, list_recurring, mark_outbound_sent,
    migrations, resolve_user_id, save_pending_confirmation,
    writes::{Cadence, MemoryKind, MessageRole, TxKind},
};

async fn test_pool() -> PgPool {
    let database_url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
    let pool = crate::connect_pool(&database_url)
        .await
        .expect("connect to TEST_DATABASE_URL");
    migrations::run(&pool).await.expect("run migrations");
    pool
}

fn unique_phone() -> String {
    format!("+1555{}", Uuid::new_v4().as_u128())
}

#[tokio::test]
async fn claim_flush_and_outbound_are_idempotent() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let phone = unique_phone();
    let user_id = resolve_user_id(&pool, &phone).await?;
    let message_id = format!("msg-{}", Uuid::new_v4());
    let outbound_key = format!("reply-{message_id}");

    assert_eq!(
        claim_slot(&pool, &message_id, Utc::now()).await?,
        ClaimResult::Process
    );
    assert_eq!(
        flush_writes(
            &pool,
            Some(&message_id),
            &[
                WriteIntent::Transaction {
                    kind: TxKind::Expense,
                    user_id,
                    amount_centavos: 18_000,
                    category: Category::Transport,
                    note: Some("grab".into()),
                    local_date: "2026-06-15".parse()?,
                    account: None,
                },
                WriteIntent::SaveTurn {
                    user_id,
                    role: MessageRole::User,
                    content: "grab 180".into(),
                },
                WriteIntent::SaveTurn {
                    user_id,
                    role: MessageRole::Assistant,
                    content: "logged it".into(),
                },
                WriteIntent::OutboundReply {
                    user_id,
                    phone: phone.clone(),
                    content: "logged it".into(),
                    dedup_key: Some(outbound_key.clone()),
                },
            ],
        )
        .await?,
        FlushResult::Committed
    );
    assert_eq!(
        claim_slot(&pool, &message_id, Utc::now()).await?,
        ClaimResult::Skip
    );

    let tx_count: i64 =
        sqlx::query("select count(*)::bigint as count from transactions where user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await?
            .try_get("count")?;
    assert_eq!(tx_count, 1);

    let outbound = claim_outbound_by_dedup_key(&pool, &outbound_key)
        .await?
        .expect("pending outbound reply");
    assert_eq!(outbound.phone, phone);
    assert_eq!(outbound.content, "logged it");
    mark_outbound_sent(&pool, outbound.id).await?;
    assert!(
        claim_outbound_by_dedup_key(&pool, &outbound_key)
            .await?
            .is_none()
    );

    Ok(())
}

#[tokio::test]
async fn memory_save_and_forget_normalize_duplicates() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let user_id = resolve_user_id(&pool, &unique_phone()).await?;

    flush_writes(
        &pool,
        None,
        &[
            WriteIntent::SaveMemory {
                user_id,
                content: "Payday: every Friday!".into(),
                kind: MemoryKind::Payday,
            },
            WriteIntent::SaveMemory {
                user_id,
                content: "payday every friday".into(),
                kind: MemoryKind::Fact,
            },
        ],
    )
    .await?;

    let memories = list_memories(&pool, user_id, 10).await?;
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].kind, "payday");

    flush_writes(
        &pool,
        None,
        &[WriteIntent::ForgetMemory {
            user_id,
            query: "payday every friday".into(),
        }],
    )
    .await?;
    assert!(list_memories(&pool, user_id, 10).await?.is_empty());

    Ok(())
}

#[tokio::test]
async fn goal_balances_and_recurring_claims_use_real_constraints() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let user_id = resolve_user_id(&pool, &unique_phone()).await?;
    let today = "2026-06-15".parse()?;

    flush_writes(
        &pool,
        None,
        &[WriteIntent::CreateGoal {
            user_id,
            name: "Japan".into(),
            target_centavos: 100_000,
            target_date: None,
        }],
    )
    .await?;
    let goal = find_goal_by_name(&pool, user_id, "Japan")
        .await?
        .expect("goal exists");
    flush_writes(
        &pool,
        None,
        &[WriteIntent::GoalContribution {
            user_id,
            goal_id: goal.id,
            amount_centavos: 25_000,
            local_date: today,
        }],
    )
    .await?;
    assert_eq!(list_goals(&pool, user_id).await?[0].saved_centavos, 25_000);

    flush_writes(
        &pool,
        None,
        &[WriteIntent::AddRecurring {
            user_id,
            recurring: RecurringInput {
                label: "rent".into(),
                kind: TxKind::Expense,
                amount_centavos: 50_000,
                category: Category::Bills,
                cadence: Cadence::Monthly,
                day_of_month: Some(15),
                day_of_week: None,
            },
        }],
    )
    .await?;
    let now = Utc.with_ymd_and_hms(2026, 6, 15, 0, 0, 0).unwrap();
    let recurring = due_recurring_today(&pool, user_id, now).await?;
    assert_eq!(recurring.len(), 1);
    assert!(claim_reminder(&pool, recurring[0].id, user_id, now).await?);
    assert!(due_recurring_today(&pool, user_id, now).await?.is_empty());
    assert_eq!(list_recurring(&pool, user_id).await?.len(), 1);

    Ok(())
}

#[tokio::test]
async fn read_tools_return_real_month_category_and_search_results() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let user_id = resolve_user_id(&pool, &unique_phone()).await?;

    flush_writes(
        &pool,
        None,
        &[
            WriteIntent::Transaction {
                kind: TxKind::Income,
                user_id,
                amount_centavos: 5_000_000,
                category: Category::Income,
                note: Some("sweldo".into()),
                local_date: "2026-06-01".parse()?,
                account: None,
            },
            WriteIntent::Transaction {
                kind: TxKind::Expense,
                user_id,
                amount_centavos: 18_000,
                category: Category::Food,
                note: Some("lunch grab".into()),
                local_date: "2026-06-05".parse()?,
                account: None,
            },
            WriteIntent::Transaction {
                kind: TxKind::Expense,
                user_id,
                amount_centavos: 78_000,
                category: Category::Food,
                note: Some("dinner".into()),
                local_date: "2026-06-12".parse()?,
                account: None,
            },
            // Different month — must be excluded from June totals.
            WriteIntent::Transaction {
                kind: TxKind::Expense,
                user_id,
                amount_centavos: 99_000,
                category: Category::Food,
                note: Some("old".into()),
                local_date: "2026-05-30".parse()?,
                account: None,
            },
        ],
    )
    .await?;

    let reader = PgFinanceRead::new(pool.clone());
    let start = "2026-06-01".parse()?;
    let end = "2026-06-30".parse()?;

    let overview = reader.month_overview(user_id, start, end).await?;
    assert_eq!(overview.income, 5_000_000);
    assert_eq!(overview.expense, 96_000);
    assert_eq!(overview.net, 4_904_000);

    let (total, count) = reader
        .category_spend(user_id, Category::Food, start, end)
        .await?;
    assert_eq!(total, 96_000, "May food spend must be excluded");
    assert_eq!(count, 2);

    // Largest-first search, scoped to June expenses.
    let biggest = reader
        .search(
            user_id,
            &TransactionSearch {
                kind: Some("expense".into()),
                start_date: Some(start),
                end_date: Some(end),
                by_amount: true,
                limit: 5,
                ..TransactionSearch::default()
            },
        )
        .await?;
    assert_eq!(biggest.first().map(|t| t.amount_centavos), Some(78_000));

    // Text search matches notes.
    let grabs = reader
        .search(
            user_id,
            &TransactionSearch {
                text: Some("grab".into()),
                limit: 5,
                ..TransactionSearch::default()
            },
        )
        .await?;
    assert_eq!(grabs.len(), 1);
    assert_eq!(grabs[0].amount_centavos, 18_000);

    Ok(())
}

#[tokio::test]
async fn pending_confirmation_confirm_applies_writes_once() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let phone = unique_phone();
    let user_id = resolve_user_id(&pool, &phone).await?;
    let now = Utc::now();

    let parked = vec![WriteIntent::Transaction {
        kind: TxKind::Expense,
        user_id,
        amount_centavos: 6_000_000,
        category: Category::Bills,
        note: Some("big bill".into()),
        local_date: "2026-06-15".parse()?,
        account: None,
    }];
    let id = save_pending_confirmation(
        &pool,
        user_id,
        &phone,
        Some("m1"),
        "log expense",
        &parked,
        now + Duration::minutes(60),
    )
    .await?;

    let pending = latest_pending_confirmation(&pool, user_id, now)
        .await?
        .expect("pending exists");
    assert_eq!(pending.id, id);
    assert_eq!(pending.writes, parked);

    // First "yes" consumes and applies; a racing second "yes" must be a no-op.
    assert!(consume_confirmation(&pool, id, user_id).await?);
    flush_writes(&pool, None, &pending.writes).await?;
    assert!(!consume_confirmation(&pool, id, user_id).await?);
    assert!(
        latest_pending_confirmation(&pool, user_id, now)
            .await?
            .is_none()
    );

    let tx_count: i64 =
        sqlx::query("select count(*)::bigint as count from transactions where user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await?
            .try_get("count")?;
    assert_eq!(tx_count, 1);
    Ok(())
}

#[tokio::test]
async fn pending_confirmation_cancel_and_expiry() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let phone = unique_phone();
    let user_id = resolve_user_id(&pool, &phone).await?;
    let now = Utc::now();

    // Cancel path.
    save_pending_confirmation(
        &pool,
        user_id,
        &phone,
        None,
        "delete the last entry",
        &[WriteIntent::DeleteLast {
            user_id,
            target_id: None,
            target_same_turn: false,
        }],
        now + Duration::minutes(60),
    )
    .await?;
    assert_eq!(cancel_pending_confirmations(&pool, user_id).await?, 1);
    assert!(
        latest_pending_confirmation(&pool, user_id, now)
            .await?
            .is_none()
    );

    // Expiry path: an already-expired confirmation is never returned.
    save_pending_confirmation(
        &pool,
        user_id,
        &phone,
        None,
        "remove a budget",
        &[WriteIntent::RemoveBudget {
            user_id,
            category: Category::Food,
        }],
        now - Duration::minutes(1),
    )
    .await?;
    assert!(
        latest_pending_confirmation(&pool, user_id, now)
            .await?
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn ledger_events_trace_create_edit_delete() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let phone = unique_phone();
    let user_id = resolve_user_id(&pool, &phone).await?;
    let message_id = format!("msg-{}", Uuid::new_v4());

    // Create carries source_message_id and writes a tx_create event.
    flush_writes(
        &pool,
        Some(&message_id),
        &[WriteIntent::Transaction {
            kind: TxKind::Expense,
            user_id,
            amount_centavos: 18_000,
            category: Category::Food,
            note: Some("lunch".into()),
            local_date: "2026-06-15".parse()?,
            account: None,
        }],
    )
    .await?;

    let tx_row = sqlx::query(
        "select id, source_message_id from transactions where user_id = $1 order by seq desc limit 1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await?;
    let tx_id: Uuid = tx_row.try_get("id")?;
    let source: Option<String> = tx_row.try_get("source_message_id")?;
    assert_eq!(source.as_deref(), Some(message_id.as_str()));

    let event_count = |event_type: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "select count(*)::bigint as c from ledger_events where transaction_id = $1 and event_type = $2",
            )
            .bind(tx_id)
            .bind(event_type)
            .fetch_one(&pool)
            .await
            .and_then(|r| r.try_get::<i64, _>("c"))
        }
    };
    assert_eq!(event_count("tx_create").await?, 1);

    // Edit writes a tx_edit event with before/after amounts.
    flush_writes(
        &pool,
        None,
        &[WriteIntent::EditLast {
            user_id,
            target_id: Some(tx_id),
            target_same_turn: false,
            amount_centavos: Some(25_000),
            category: None,
            note: None,
        }],
    )
    .await?;
    let edit = sqlx::query(
        "select before, after from ledger_events where transaction_id = $1 and event_type = 'tx_edit' limit 1",
    )
    .bind(tx_id)
    .fetch_one(&pool)
    .await?;
    let before: serde_json::Value = edit.try_get("before")?;
    let after: serde_json::Value = edit.try_get("after")?;
    assert_eq!(before["amount_centavos"], 18_000);
    assert_eq!(after["amount_centavos"], 25_000);

    // Delete writes a tx_delete event capturing the before-state.
    flush_writes(
        &pool,
        None,
        &[WriteIntent::DeleteLast {
            user_id,
            target_id: Some(tx_id),
            target_same_turn: false,
        }],
    )
    .await?;
    assert_eq!(event_count("tx_delete").await?, 1);

    Ok(())
}

#[tokio::test]
async fn superseded_flush_writes_no_ledger_events() -> anyhow::Result<()> {
    let pool = test_pool().await;
    let phone = unique_phone();
    let user_id = resolve_user_id(&pool, &phone).await?;
    let message_id = format!("msg-{}", Uuid::new_v4());

    // Claim + complete the message id once.
    assert_eq!(
        claim_slot(&pool, &message_id, Utc::now()).await?,
        ClaimResult::Process
    );
    flush_writes(
        &pool,
        Some(&message_id),
        &[WriteIntent::Transaction {
            kind: TxKind::Expense,
            user_id,
            amount_centavos: 10_000,
            category: Category::Food,
            note: None,
            local_date: "2026-06-15".parse()?,
            account: None,
        }],
    )
    .await?;

    let count_events = || {
        let pool = pool.clone();
        async move {
            sqlx::query("select count(*)::bigint as c from ledger_events where user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .and_then(|r| r.try_get::<i64, _>("c"))
        }
    };
    assert_eq!(count_events().await?, 1);

    // A second flush under the same (already-completed) message id is
    // superseded and rolled back — it must not create extra events.
    let result = flush_writes(
        &pool,
        Some(&message_id),
        &[WriteIntent::Transaction {
            kind: TxKind::Expense,
            user_id,
            amount_centavos: 99_000,
            category: Category::Food,
            note: None,
            local_date: "2026-06-15".parse()?,
            account: None,
        }],
    )
    .await?;
    assert_eq!(result, FlushResult::Superseded);
    assert_eq!(count_events().await?, 1);

    Ok(())
}

#[tokio::test]
async fn outbound_dead_letters_after_max_or_on_non_retryable() -> anyhow::Result<()> {
    use crate::{claim_due_outbound_messages, mark_outbound_failed};

    let pool = test_pool().await;
    let phone = unique_phone();
    let user_id = resolve_user_id(&pool, &phone).await?;

    // Helper: insert one outbound row with a chosen attempt_count/max_attempts
    // and return its id, then claim it (-> 'sending') so mark_outbound_failed
    // applies.
    async fn seed(
        pool: &PgPool,
        user_id: Uuid,
        phone: &str,
        dedup: &str,
        attempt_count: i32,
        max_attempts: i32,
    ) -> anyhow::Result<Uuid> {
        let id: Uuid = sqlx::query(
            r#"
            insert into outbound_messages
              (user_id, phone, content, dedup_key, status, attempt_count, max_attempts, next_attempt_at)
            values ($1, $2, 'hi', $3, 'sending', $4, $5, now())
            returning id
            "#,
        )
        .bind(user_id)
        .bind(phone)
        .bind(dedup)
        .bind(attempt_count)
        .bind(max_attempts)
        .fetch_one(pool)
        .await?
        .try_get("id")?;
        Ok(id)
    }

    async fn status_of(pool: &PgPool, id: Uuid) -> anyhow::Result<(String, bool)> {
        let row = sqlx::query(
            "select status, dead_lettered_at is not null as dead from outbound_messages where id = $1",
        )
        .bind(id)
        .fetch_one(pool)
        .await?;
        Ok((row.try_get("status")?, row.try_get("dead")?))
    }

    // Retryable with attempts left -> back to pending, not dead-lettered.
    let id = seed(&pool, user_id, &phone, &format!("k1-{user_id}"), 1, 8).await?;
    mark_outbound_failed(&pool, id, "server_error:500", true).await?;
    assert_eq!(status_of(&pool, id).await?, ("pending".to_string(), false));

    // Retryable but attempts exhausted -> dead-lettered.
    let id = seed(&pool, user_id, &phone, &format!("k2-{user_id}"), 8, 8).await?;
    mark_outbound_failed(&pool, id, "server_error:500", true).await?;
    assert_eq!(status_of(&pool, id).await?, ("failed".to_string(), true));

    // Non-retryable (auth) -> dead-lettered immediately even with attempts left.
    let id = seed(&pool, user_id, &phone, &format!("k3-{user_id}"), 1, 8).await?;
    mark_outbound_failed(&pool, id, "auth:401", false).await?;
    assert_eq!(status_of(&pool, id).await?, ("failed".to_string(), true));

    // A failed row is never reclaimed by the due-claimer.
    let claimed = claim_due_outbound_messages(&pool, Utc::now(), 50).await?;
    assert!(
        !claimed
            .iter()
            .any(|m| m.dedup_key.as_deref() == Some(&format!("k3-{user_id}"))),
        "dead-lettered messages must not be reclaimed"
    );

    Ok(())
}

#[tokio::test]
async fn transfers_do_not_affect_income_or_expense_totals() -> anyhow::Result<()> {
    use crate::{PgFinanceRead, search_transfers};

    let pool = test_pool().await;
    let user_id = resolve_user_id(&pool, &unique_phone()).await?;

    flush_writes(
        &pool,
        None,
        &[
            WriteIntent::Transaction {
                kind: TxKind::Income,
                user_id,
                amount_centavos: 5_000_000,
                category: Category::Income,
                note: Some("sweldo".into()),
                local_date: "2026-06-01".parse()?,
                account: Some("BPI".into()),
            },
            WriteIntent::Transfer {
                user_id,
                amount_centavos: 1_000_000,
                from_account: Some("BPI".into()),
                to_account: Some("savings".into()),
                note: Some("move to savings".into()),
                local_date: "2026-06-02".parse()?,
            },
        ],
    )
    .await?;

    let reader = PgFinanceRead::new(pool.clone());
    let overview = reader
        .month_overview(user_id, "2026-06-01".parse()?, "2026-06-30".parse()?)
        .await?;
    // The transfer must not show up as income or expense.
    assert_eq!(overview.income, 5_000_000);
    assert_eq!(overview.expense, 0);

    let transfers = search_transfers(&pool, user_id, Some("savings"), 10).await?;
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].amount_centavos, 1_000_000);
    assert_eq!(transfers[0].to_account.as_deref(), Some("savings"));

    Ok(())
}
