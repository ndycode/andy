use sqlx::{PgPool, Postgres, Row, Transaction};

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0000_tiresome_paibok",
        include_str!("../../../packages/db/migrations/0000_tiresome_paibok.sql"),
    ),
    (
        "0001_workable_golden_guardian",
        include_str!("../../../packages/db/migrations/0001_workable_golden_guardian.sql"),
    ),
    (
        "0002_deep_firebird",
        include_str!("../../../packages/db/migrations/0002_deep_firebird.sql"),
    ),
    (
        "0003_complex_wolverine",
        include_str!("../../../packages/db/migrations/0003_complex_wolverine.sql"),
    ),
    (
        "0004_premium_scream",
        include_str!("../../../packages/db/migrations/0004_premium_scream.sql"),
    ),
    (
        "0005_correctness_seq_budgets_memory",
        include_str!("../../../packages/db/migrations/0005_correctness_seq_budgets_memory.sql"),
    ),
    (
        "0006_correctness_nudges_pk_goal_check",
        include_str!("../../../packages/db/migrations/0006_correctness_nudges_pk_goal_check.sql"),
    ),
    (
        "0007_schema_hardening_checks",
        include_str!("../../../packages/db/migrations/0007_schema_hardening_checks.sql"),
    ),
    (
        "0008_messages_seq_ordering",
        include_str!("../../../packages/db/migrations/0008_messages_seq_ordering.sql"),
    ),
    (
        "0009_schema_audit_0009",
        include_str!("../../../packages/db/migrations/0009_schema_audit_0009.sql"),
    ),
    (
        "0010_audit_remediation_0010",
        include_str!("../../../packages/db/migrations/0010_audit_remediation_0010.sql"),
    ),
    (
        "0011_damp_luckman",
        include_str!("../../../packages/db/migrations/0011_damp_luckman.sql"),
    ),
    (
        "0012_cool_gauntlet",
        include_str!("../../../packages/db/migrations/0012_cool_gauntlet.sql"),
    ),
    (
        "0013_outbound_messages",
        include_str!("../../../packages/db/migrations/0013_outbound_messages.sql"),
    ),
];

pub async fn run(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(603669849013)")
        .execute(&mut *tx)
        .await?;
    ensure_tracking_table(&mut tx).await?;
    baseline_existing_schema(&mut tx).await?;

    for (version, sql) in MIGRATIONS {
        if migration_applied(&mut tx, version).await? {
            continue;
        }
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
        mark_applied(&mut tx, version).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn ensure_tracking_table(tx: &mut Transaction<'_, Postgres>) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        create table if not exists _andy_migrations (
            version text primary key,
            applied_at timestamp with time zone default now() not null
        )
        "#,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn baseline_existing_schema(tx: &mut Transaction<'_, Postgres>) -> Result<(), sqlx::Error> {
    if applied_count(tx).await? > 0 || !table_exists(tx, "users").await? {
        return Ok(());
    }

    let outbound_exists = table_exists(tx, "outbound_messages").await?;
    let baseline_through = if outbound_exists {
        MIGRATIONS.len()
    } else {
        MIGRATIONS.len() - 1
    };
    for (version, _) in &MIGRATIONS[..baseline_through] {
        mark_applied(tx, version).await?;
    }
    Ok(())
}

async fn applied_count(tx: &mut Transaction<'_, Postgres>) -> Result<i64, sqlx::Error> {
    let row = sqlx::query("select count(*)::bigint as count from _andy_migrations")
        .fetch_one(&mut **tx)
        .await?;
    row.try_get("count")
}

async fn migration_applied(
    tx: &mut Transaction<'_, Postgres>,
    version: &str,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query("select version from _andy_migrations where version = $1")
        .bind(version)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row.is_some())
}

async fn mark_applied(
    tx: &mut Transaction<'_, Postgres>,
    version: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        insert into _andy_migrations (version)
        values ($1)
        on conflict (version) do nothing
        "#,
    )
    .bind(version)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn table_exists(tx: &mut Transaction<'_, Postgres>, name: &str) -> Result<bool, sqlx::Error> {
    let row = sqlx::query("select to_regclass($1) is not null as exists")
        .bind(format!("public.{name}"))
        .fetch_one(&mut **tx)
        .await?;
    row.try_get("exists")
}
