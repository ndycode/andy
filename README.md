# andy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Rust](https://img.shields.io/badge/runtime-Rust-b7410e)](https://www.rust-lang.org/)

**a private finance assistant that lives in iMessage.**

text what happened with your money. andy keeps it organized, checks your budgets, tracks your goals, reminds you about recurring bills, and answers questions like "how much did i spend on food?"

## preview

https://github.com/user-attachments/assets/04814e9b-0d80-44c1-94f9-233e1d803ebd

## the idea

most money apps make you open the app, pick a category, type an amount, and clean it up later.

andy is for the thing you already do: send a quick message.

| text andy | what happens |
| --- | --- |
| `grab 180` | logs transport |
| `make that 200` | fixes the last entry |
| `food budget 8k` | sets a food budget |
| `save 30k for japan by december` | starts a savings goal |
| `rent 18k every 1st` | adds a rent reminder |
| `how much on food this month?` | gives the real total |

it is tuned for one person in the Philippines: PHP, Asia/Manila, sweldo, Grab, GCash-style spending, and blunt check-ins like "am i still okay this month?"

## what andy handles

- logs expenses and income from normal iMessage texts
- keeps categories, notes, dates, and corrections straight
- warns when a budget is getting tight
- tracks savings goals and whether they are on pace
- remembers useful facts like payday, usual merchants, and preferences
- reminds you about recurring bills before they slip
- answers from what you actually logged
- avoids double-logging when a message gets delivered twice

## why it matters

**quick entries stay quick.** `coffee 160` is enough.

**corrections are natural.** `no make that 200` edits the thing you just logged.

**the math stays exact.** pesos and centavos are stored as whole centavos, so totals do not drift.

**private means private.** this is built for a single allowed phone number, not public signup.

**answers have receipts.** when andy says what you spent, it is looking at saved records.

## what is in this repo

andy is now a Rust workspace. the old TypeScript/Bun app code was removed; SQL migrations stayed so the existing database history remains intact.

| path | what it is for |
| --- | --- |
| `crates/shared` | money, time, categories, budgets, goals, env, allowlist, safety helpers |
| `crates/db` | database reads/writes, message dedup, reminders, maintenance |
| `crates/ai` | OpenRouter client and the finance tools Andy can call |
| `crates/api` | Sendblue webhook, replies, cron jobs, route guards |
| `xtask` | one command for local and CI checks |
| `packages/db/migrations` | preserved database migrations |

## routes

| route | purpose |
| --- | --- |
| `GET /health` | health check |
| `POST /webhooks/sendblue?t=<WEBHOOK_URL_TOKEN>` | inbound Sendblue messages |
| `GET /api/cron/daily` | daily reminders, budget checks, cleanup |

## env

required:

```text
DATABASE_URL
SENDBLUE_API_KEY
SENDBLUE_API_SECRET
SENDBLUE_FROM_NUMBER
WEBHOOK_URL_TOKEN
CRON_SECRET
ALLOWED_PHONE
```

optional:

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

database integration tests need a real Postgres URL:

```bash
TEST_DATABASE_URL=postgres://... cargo test --workspace --features andy_db/db-integration
```

live provider smoke checks are opt-in because they send a real iMessage:

```bash
ANDY_LIVE_SMOKE_SEND=1 cargo xtask smoke-live
```

## status

this is a personal app, not a hosted product. running it live needs the owner's Sendblue account, a database, and optional OpenRouter credentials.

## security

financial data, personal messages, phone numbers, and provider secrets sit near this code. report security issues privately through [SECURITY.md](./SECURITY.md), not a public issue.

## license

[MIT](./LICENSE) © ndycode
