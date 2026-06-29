# andy: iMessage AI finance assistant

[![CI](https://github.com/ndycode/andy/actions/workflows/ci.yml/badge.svg)](https://github.com/ndycode/andy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Rust](https://img.shields.io/badge/runtime-Rust-b7410e)](https://www.rust-lang.org/)

> iMessage personal finance assistant for expense tracking, budgets, savings goals, recurring reminders, and SQL-backed spending answers.

## what andy does

andy is a single-user, serverless finance assistant for iMessage. it parses everyday spending text into typed transactions, budgets, savings goals, recurring reminders, and memories. it stores money as exact integer centavos, then answers from SQL aggregation instead of chat history.

built for the Philippines by default: PHP, Asia/Manila, sweldo, Grab, and direct questions like "how much did i spend?"

## features

- natural-language transaction logging over iMessage
- expense tracking with categories, notes, merchants, and timestamps
- budget tracking with proactive nudges
- savings goals and goal-pace checks
- recurring reminders for bills and planned payments
- memory tools for stable user preferences
- SQL-backed spending summaries instead of chat-history guesses
- exact PHP centavo math with no floating point in the money path
- crash-safe Sendblue webhook dedup and transactional flush

## shape

```text
iMessage -> Sendblue webhook -> Rust API (Vercel Rust Runtime, sin1)
                                      |
                  +-------------------+--------------------+
                  |                   |                    |
                  v                   v                    v
             crates/shared        crates/ai            crates/db
             money, time,         OpenRouter           sqlx + Postgres
             budget, goals,       tool calls           atomic dedup,
             env, security        buffered writes      transactional flush
```

| part | what it owns |
| --- | --- |
| `crates/shared` | centavo math, fixed-offset local time, categories, allowlist, budgets, goal pace, env validation, logging, security helpers |
| `crates/db` | sqlx query/write layer on existing Postgres schema: users, transactions, budgets, goals, memories, recurring items, messages, nudges, weekly summaries, claim/flush dedup, maintenance reapers |
| `crates/ai` | direct OpenRouter Chat Completions client, finance tool schemas, tool-call execution, buffered writes, model config |
| `crates/api` | Axum/Vercel webhook and cron edge: Sendblue adapters, body/auth/rate guards, inbound handler, budget reactions, daily checks, reminders, goal nudges, weekly recap, hygiene |
| `xtask` | repo CI command: format, clippy, tests, optional DB integration, production build |

## stack

Rust stable, edition 2024. Axum. sqlx. Postgres 16-compatible SQL. Vercel Rust Runtime. OpenRouter Chat Completions. Sendblue. Cargo xtask.

SQL migrations remain in `packages/db/migrations` to preserve the production database history.

## run the checks

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask ci
```

DB integration tests run when `TEST_DATABASE_URL` points at real Postgres:

```bash
TEST_DATABASE_URL=postgres://... cargo test --workspace --features andy_db/db-integration
```

## deployment

Vercel routes all requests to `api/index.rs`.

- `GET /health`
- `POST /webhooks/sendblue?t=<WEBHOOK_URL_TOKEN>`
- `GET /api/cron/daily` with `Authorization: Bearer <CRON_SECRET>`

Required env stays stable: `DATABASE_URL`, `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `WEBHOOK_URL_TOKEN`, `CRON_SECRET`, `ALLOWED_PHONE`, optional `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `APP_TIMEZONE`, and `APP_TIMEZONE_OFFSET_MINUTES`.

## security

financial data, personal messages, and provider secrets live near this code. please report security issues privately through [SECURITY.md](./SECURITY.md), not a public issue.

## license

[MIT](./LICENSE) © ndycode
