# andy: money over imessage

[![CI](https://github.com/ndycode/andy/actions/workflows/ci.yml/badge.svg)](https://github.com/ndycode/andy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![Biome](https://img.shields.io/badge/lint%20%2F%20format-Biome-60a5fa)](https://biomejs.dev/)

> text your money like a normal person. andy logs it, answers from real data, and nudges before the budget gets spicy.

## demo

<a href="https://cdn.jsdelivr.net/gh/ndycode/andy@main/public/demo/messages.mp4">
  <img src="./public/demo/messages-poster.jpg" alt="andy iMessage demo preview" width="360">
</a>

tap the preview to play the demo. GitHub readmes strip normal video controls, so the preview links to the committed mp4 with a mobile-safe `video/mp4` response.

## what andy does

andy is a single-user, serverless finance assistant for iMessage. it turns casual text into typed transactions, budgets, savings goals, recurring reminders, and memories. it stores money as exact integer centavos, then answers from SQL aggregation, never from chat vibes.

built for the Philippines by default: PHP, Asia/Manila, GCash, sweldo, Grab, and the kind of "wait, how much did i spend?" questions people actually text.

**600+ tests. TypeScript strict. Biome plus custom no-excuse lint. unit, integration, and build gates in CI.**

## shape

```text
iMessage -> Sendblue webhook -> Hono API (Vercel Node 22, sin1)
                                      |
                  +-------------------+--------------------+
                  |                   |                    |
                  v                   v                    v
          packages/shared      packages/ai          packages/db
          money, time,         AI SDK v6            Drizzle + Postgres
          budget, goals,       ToolLoopAgent        atomic dedup,
          env, logging         28 finance tools     transactional flush
```

| part | what it owns |
| --- | --- |
| `packages/shared` | pure core with only `zod` and `@t3-oss/env-core`: centavo math, fixed-offset local time, categories, allowlist, budgets, goal pace, env validation, logs, security helpers |
| `packages/db` | Drizzle schema plus query/write layer on TCP Postgres: users, transactions, budgets, goals, memories, recurring items, messages, nudges, weekly summaries, claim/flush dedup, maintenance reapers |
| `packages/ai` | AI SDK v6 `ToolLoopAgent`, OpenRouter model wiring, 28 profile-selected finance tools, buffered writes, SQL-backed reads, memory/goal/budget/recurring tools, proactive copy |
| `apps/api` | Hono webhook and cron edge: Sendblue adapters, body/auth/rate guards, three-phase inbound handler, budget reactions, daily checks, reminders, goal nudges, weekly recap, hygiene |

## stack

Bun `1.3.14`. Node.js 22 on Vercel. TypeScript 6 strict. Hono. ky. Drizzle ORM. postgres.js. Postgres 16-compatible SQL. Vercel Build Output API. AI SDK v6. OpenRouter. Zod. Biome. Turbo.

## why it is built this way

**money cannot be fuzzy.** amounts are integer centavos end to end. the model extracts the raw token, like `"25k"` or `"180.50"`, then one parser turns it into exact money. display is the only place pesos get decimal formatting.

**redelivery cannot double-log.** every inbound message claims a dedup marker first. true duplicate or in-flight sibling, skip. stale crash marker, safely retry. no two workers get to flush the same message.

**the model call cannot pin the database.** the handler claims in one short transaction, runs the model with buffered write intents, then flushes in one short transaction. no connection sits around waiting for an LLM.

**corrections hit the thing you just meant.** `grab 180, no make it 200` becomes one expense at the final amount. `make that 200` edits the just-logged row, not some random old transaction.

**read answers come from SQL.** "how much on food?" calls tools backed by real tables. no guessing from chat history. no vague "looks like". give the number or say nothing is logged.

**failures tell the truth.** out of credits gets an out-of-credits reply. burst limits ask for a resend. committed data never gets a fake "something broke" reply just because the outbound text failed.

## project status

this is a personal, single-user showcase. running it live needs the owner's Sendblue account, a TCP/session Postgres database, and an OpenRouter key. it is not built as a plug-and-play hosted product.

the core is still easy to inspect: money math, local time, dedup, DB writes, tools, budgets, goals, memories, and recurring behavior all run in tests without provider accounts. DB integration tests run only when `TEST_DATABASE_URL` points at real Postgres.

## run the checks

```bash
bun install
bun run typecheck      # tsc --noEmit across the repo
bun run lint           # Biome
bun run lint:no-excuse # repo-specific safety lint
bun test               # 600+ tests, DB integration gated by TEST_DATABASE_URL
bun run build          # production Vercel Build Output API bundle
bun run ci:local       # full gate with ephemeral Postgres, needs Docker
```

`bun run ci:local` mirrors `.github/workflows/ci.yml`: typecheck, lint, unit tests, DB integration when Docker is available, and build.

## contributing

small, focused PRs are welcome. big rewrites, multi-user hosting, and "make this deployable for everyone" are out of scope.

read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. if your change touches money, dedup, the handler, or DB writes, bring tests.

## security

financial data, personal messages, and provider secrets live near this code. please report security issues privately through [SECURITY.md](./SECURITY.md), not a public issue.

## conduct

be direct, useful, and kind. no harassment, no doxxing, no personal attacks. details are in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## license

[MIT](./LICENSE) © ndycode
