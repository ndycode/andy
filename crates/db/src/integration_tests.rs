use andy_shared::categories::Category;
use chrono::{TimeZone, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    ClaimResult, FlushResult, RecurringInput, WriteIntent, claim_outbound_by_dedup_key,
    claim_reminder, claim_slot, due_recurring_today, find_goal_by_name, flush_writes, list_goals,
    list_memories, list_recurring, mark_outbound_sent, migrations, resolve_user_id,
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
