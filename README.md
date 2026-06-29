# andy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Rust](https://img.shields.io/badge/runtime-Rust-b7410e)](https://www.rust-lang.org/)

**an iMessage finance assistant that turns messy everyday texts into a real Postgres ledger.**

text it like a person. andy logs the transaction, keeps exact centavo math, tracks budgets and goals, remembers durable preferences, and answers money questions from SQL instead of guessing from chat history.

## demo

https://github.com/user-attachments/assets/04814e9b-0d80-44c1-94f9-233e1d803ebd

## how it feels

| you text | andy does |
| --- | --- |
| `grab 180` | logs a Transport expense |
| `make that 200` | edits the transaction from this same turn |
| `food budget 8k` | sets a monthly Food budget |
| `save 30k for japan by december` | creates a goal with a deadline |
| `rent 18k every 1st` | adds a recurring reminder |
| `how much on food this month?` | answers from transaction aggregates |

andy is tuned for a single owner in the Philippines: PHP, Asia/Manila, sweldo, Grab, GCash-style spending, and direct questions like "am i still within budget?"

## what it handles

- iMessage expense and income logging through Sendblue
- budgets, threshold nudges, and spending pace warnings
- savings goals, contributions, deadline pace, and progress checks
- recurring reminders for bills and planned payments
- stable memory for preferences, payday facts, people, and habits
- SQL-backed reads for summaries, category breakdowns, history, and insights
- exact integer-centavo money math end to end
- crash-safe webhook dedup and transactional write flushes

## why it is built this way

**money stays exact.** amounts are stored as integer centavos. no float math in the ledger path.

**one message logs once.** each inbound webhook claims a marker before work and completes it inside the final write transaction. redelivery can retry safely without double-counting.

**the model never owns identity.** user id, phone allowlist, and write targets are server-side. model tool calls only provide intent arguments.

**OpenRouter does not hold the DB hostage.** the handler snapshots short context, releases the DB, runs the model/tool loop, then flushes buffered writes in one short transaction.

**answers come from data.** spending questions use Postgres queries. if the data is not there, andy says so.

## repo shape

```text
iMessage
  -> Sendblue webhook
    -> Rust API on Vercel (sin1)
      -> OpenRouter tool-call loop
      -> Postgres ledger
```

| path | owns |
| --- | --- |
| `crates/shared` | money parsing/formatting, categories, time, budgets, goals, env, allowlist, security |
| `crates/db` | sqlx Postgres reads/writes, migrations, claim/flush dedup, reminders, maintenance |
| `crates/ai` | OpenRouter client, model config, finance tool schemas, tool execution, reply synthesis |
| `crates/api` | Axum routes, Sendblue inbound/outbound, webhook guardrails, cron, budget reactions |
| `xtask` | local and CI verification command |

SQL migration history stays in `packages/db/migrations` so production databases keep the same schema lineage.

## public contract

| route | behavior |
| --- | --- |
| `GET /health` | returns `{ "status": "ok", "service": "andy" }` |
| `POST /webhooks/sendblue?t=<WEBHOOK_URL_TOKEN>` | handles inbound Sendblue messages |
| `GET /api/cron/daily` | runs daily checks with `Authorization: Bearer <CRON_SECRET>` |

required env:

```text
DATABASE_URL
SENDBLUE_API_KEY
SENDBLUE_API_SECRET
SENDBLUE_FROM_NUMBER
WEBHOOK_URL_TOKEN
CRON_SECRET
ALLOWED_PHONE
```

optional env:

```text
OPENROUTER_API_KEY
OPENROUTER_MODEL
APP_TIMEZONE
APP_TIMEZONE_OFFSET_MINUTES
```

## checks

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask ci
```

DB integration runs only when Postgres is available:

```bash
TEST_DATABASE_URL=postgres://... cargo test --workspace --features andy_db/db-integration
```

## status

this is a personal, single-user app. it is not a multi-tenant finance product or a plug-and-play hosted service. running it live needs the owner's Sendblue account, a Postgres database, and optional OpenRouter credentials.

## security

financial data, personal messages, phone numbers, and provider secrets sit near this code. report security issues privately through [SECURITY.md](./SECURITY.md), not a public issue.

## license

[MIT](./LICENSE) © ndycode
