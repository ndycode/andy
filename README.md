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
| `GET /health` | static liveness check, no env or DB |
| `GET /ready` | readiness: validates env, pings DB, reports migration + provider config (no secrets) |
| `POST /webhooks/sendblue?t=<WEBHOOK_URL_TOKEN>` | inbound Sendblue messages |
| `GET /api/cron/daily` | daily reminders, budget checks, cleanup |

`/health` is for liveness probes and never touches env or the database.
`/ready` is for deploy gating — it returns `200` only when required env is
present, the database answers a lightweight query, and all bundled migrations
are applied. It reports whether OpenRouter and Sendblue are configured as
booleans and never echoes a key, secret, or connection string:

```json
{
  "ok": true,
  "service": "andy",
  "db": "ok",
  "openrouterConfigured": true,
  "sendblueConfigured": true,
  "migrations": "ok"
}
```

## database migrations

Migrations are forward-only and bundled into the binary. Run them once per
deploy, before routing traffic to the new build:

```bash
cargo xtask migrate
```

`migrate` loads env, connects with `DATABASE_URL`, applies any pending
migrations under an advisory lock, and exits non-zero on failure so a deploy
pipeline can gate on it. It is idempotent and safe to re-run. Recommended
deploy order: **migrate → deploy → verify `/ready` returns 200**.

## answering with real data

Andy answers money questions from saved records, not guesses. The model calls
read-only tools — month overview, category spend, transaction search, budgets,
goals, recurring — and replies with the period, total, count, and the largest
relevant item (e.g. "You spent ₱4,820.00 on Food this month across 12 entries.
Biggest was lunch ₱780.00 on Jun 12."). Read tools can never modify the ledger.

## write safety and confirmation

Before anything is committed, a deterministic policy classifies the turn's
writes. Ordinary single logs and budgets commit immediately. Destructive
actions (delete/undo, removing a budget/goal/reminder, forgetting a memory),
unusually large amounts (≥ `ANDY_CONFIRM_AMOUNT_THRESHOLD_CENTAVOS`, default
₱50,000.00), too many writes at once, or mixed destructive+constructive turns
are held and Andy asks you to confirm. Reply "yes" to apply, "no" to cancel.
Pending confirmations expire after an hour. The model is never the final
authority on dangerous ledger changes.

## auditability

Every transaction stores the inbound `source_message_id` it came from, and each
create/edit/delete appends a sanitized row to an append-only `ledger_events`
table, so any number can be traced back to the message that produced it.

## env

required:

```text
DATABASE_URL
SENDBLUE_API_KEY
SENDBLUE_API_SECRET
SENDBLUE_FROM_NUMBER
WEBHOOK_URL_TOKEN          # or WEBHOOK_URL_TOKEN_SHA256 (see below)
CRON_SECRET
ALLOWED_PHONE
```

optional:

```text
WEBHOOK_URL_TOKEN_SHA256             # store the token as a sha256 hash instead of plaintext
OPENROUTER_API_KEY
OPENROUTER_MODEL
OPENROUTER_BASE_URL                  # OpenRouter-compatible proxy/self-host; mainly for tests
ANDY_CONFIRM_AMOUNT_THRESHOLD_CENTAVOS  # confirmation threshold, default 5_000_000 (₱50k)
ANDY_INBOUND_RATE_LIMIT                  # default 60
ANDY_INBOUND_RATE_WINDOW_SECONDS         # default 60
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
