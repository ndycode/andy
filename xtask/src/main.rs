#![forbid(unsafe_code)]

use andy_ai::{OpenRouterClient, openrouter::ChatMessage, resolve_model_config};
use andy_api::outbound::SendblueClient;
use andy_shared::env::Env;
use anyhow::{Context, bail};
use std::{env, process::Stdio};
use tokio::process::Command;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("ci") | None => ci().await,
        Some("migrate") => migrate().await,
        Some("smoke-live") => smoke_live().await,
        Some(other) => bail!("unknown xtask command: {other}"),
    }
}

/// Run database migrations once, for deploy/release. Connects with the process
/// `DATABASE_URL`, applies `andy_db::migrations::run`, and exits nonzero on
/// failure so a deploy pipeline can gate on it. Safe to run repeatedly:
/// migrations are forward-only and idempotently tracked.
async fn migrate() -> anyhow::Result<()> {
    let env = Env::from_process().context("load environment")?;
    let pool = andy_db::connect_pool(&env.database_url)
        .await
        .context("connect DATABASE_URL")?;
    andy_db::migrations::run(&pool)
        .await
        .context("run database migrations")?;
    println!("migrations applied");
    Ok(())
}

async fn ci() -> anyhow::Result<()> {
    run("cargo", &["fmt", "--check"]).await?;
    run(
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
    )
    .await?;
    run("cargo", &["test", "--workspace"]).await?;

    if env::var("TEST_DATABASE_URL").is_ok() {
        run(
            "cargo",
            &[
                "test",
                "--workspace",
                "--features",
                "andy_db/db-integration",
            ],
        )
        .await?;
    }

    run("cargo", &["build", "-p", "andy_api", "--bin", "andy_api"]).await?;
    Ok(())
}

async fn smoke_live() -> anyhow::Result<()> {
    let env = Env::from_process()?;
    if std::env::var("ANDY_LIVE_SMOKE_SEND").as_deref() != Ok("1") {
        bail!(
            "ANDY_LIVE_SMOKE_SEND=1 is required because smoke-live sends a real Sendblue message to ALLOWED_PHONE"
        );
    }

    let pool = andy_db::connect_pool(&env.database_url)
        .await
        .context("connect DATABASE_URL")?;
    andy_db::migrations::run(&pool)
        .await
        .context("run database migrations")?;

    let api_key = env
        .openrouter_api_key
        .clone()
        .context("OPENROUTER_API_KEY is required for smoke-live")?;
    let model_config = resolve_model_config(env.openrouter_model.as_deref(), None)?;
    let openrouter = OpenRouterClient::new(api_key, model_config);
    let model_reply = openrouter
        .chat(&[
            ChatMessage::text("system", "Reply with exactly: ok"),
            ChatMessage::text("user", "live smoke check"),
        ])
        .await
        .context("OpenRouter live smoke failed")?;
    if !model_reply.trim().eq_ignore_ascii_case("ok") {
        bail!("OpenRouter smoke returned unexpected reply: {model_reply}");
    }

    SendblueClient::from_env(&env)
        .send_message(&env.allowed_phone, "andy live smoke ok")
        .await
        .context("Sendblue live smoke failed")?;
    println!("live smoke passed: database migrated, OpenRouter replied ok, Sendblue sent");
    Ok(())
}

async fn run(program: &str, args: &[&str]) -> anyhow::Result<()> {
    println!("▸ {program} {}", args.join(" "));
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .status()
        .await
        .with_context(|| format!("failed to spawn {program}"))?;
    if !status.success() {
        bail!("{program} {} failed with {status}", args.join(" "));
    }
    Ok(())
}
