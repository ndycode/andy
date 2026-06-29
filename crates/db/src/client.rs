use sqlx::{PgPool, postgres::PgPoolOptions};
use std::time::Duration;

const MAX_CONNECTIONS: u32 = 1;

#[must_use]
pub fn is_pooler_url(url: &str) -> bool {
    url.contains(":6543") || url.contains("-pooler") || url.contains("pgbouncer=true")
}

pub async fn connect_pool(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(20))
        .connect(database_url)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_transaction_pooler_urls() {
        assert!(is_pooler_url("postgres://u:p@db.example.com:6543/postgres"));
        assert!(is_pooler_url(
            "postgres://u:p@ep-cool-pooler.aws.neon.tech/db"
        ));
        assert!(is_pooler_url("postgres://u:p@host/db?pgbouncer=true"));
        assert!(!is_pooler_url(
            "postgres://postgres:postgres@localhost:5432/andy"
        ));
    }
}
