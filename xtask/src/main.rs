#![forbid(unsafe_code)]

use anyhow::{Context, bail};
use std::{env, process::Stdio};
use tokio::process::Command;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("ci") | None => ci().await,
        Some(other) => bail!("unknown xtask command: {other}"),
    }
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
