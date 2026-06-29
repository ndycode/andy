use sqlx::{PgPool, migrate::Migrator};

static MIGRATOR: Migrator = sqlx::migrate!("../../packages/db/migrations");

pub async fn run(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}
