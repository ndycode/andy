# Andy — an iMessage personal finance assistant

[![CI](https://github.com/ndycode/andy/actions/workflows/ci.yml/badge.svg)](https://github.com/ndycode/andy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![Biome](https://img.shields.io/badge/lint%20%2F%20format-Biome-60a5fa)](https://biomejs.dev/)

> Text your money in plain language. An AI agent logs it, answers questions from real data, and nudges you — all over iMessage.

## Demo

https://github.com/user-attachments/assets/aaec29e8-fcaa-4cfe-8a50-0288a6d0bede

Andy is a single-user, serverless finance assistant. You talk to it like a friend; it turns natural language into typed financial transactions, budgets, savings goals, recurring reminders, and memories; persists everything with exact integer-centavo money math; and answers questions from real SQL aggregation — never from chat history. It's built for the Philippines (PHP, Asia/Manila, GCash/sweldo idioms).

**600+ tests · TypeScript strict · Biome + custom no-excuse lint · unit/integration/build green in CI.**

---

## Architecture

A Bun workspaces monorepo, deployed serverless on Vercel.

```
iMessage ─▶ Sendblue webhook ─▶ Hono API (Vercel Node 22, sin1)
                                     │
                  ┌──────────────────┼────────────────────┐
                  ▼                  ▼                    ▼
          packages/shared     packages/ai           packages/db
          money · time ·      AI SDK v6             Drizzle + Postgres
          budget · goals ·    ToolLoopAgent         atomic dedup ·
          env · logging       28 finance tools      transactional flush
```

| Package | Responsibility |
|---|---|
| `packages/shared` | Pure, minimal-dependency core (only `zod` + `@t3-oss/env-core`; no internal cross-package deps): integer-centavo money math, fixed-offset local time, E.164 allowlist, categories, budgets, goal pace, env validation, structured logging, and security helpers |
| `packages/db` | Drizzle schema + query/write layer on TCP Postgres (Neon, Supabase, or any session-capable Postgres). Owns users, transactions, budgets, savings goals, memories, recurring items, conversation turns, nudges, weekly summaries, atomic claim/flush dedup, idempotent writes, and maintenance reapers |
| `packages/ai` | AI SDK v6 `ToolLoopAgent` with 28 profile-selected finance tools, buffered write intents, read tools backed by SQL, memory/goal/budget/recurring tool families, proactive copy generation, and one real free OpenRouter model |
| `apps/api` | Hono webhook + cron boundary. Owns Sendblue inbound/outbound adapters, body/auth/rate-limit guards, the three-phase inbound handler, in-the-moment budget reactions, proactive daily checks, recurring reminders, goal-pace nudges, weekly recap, and hygiene jobs |

**Stack:** Bun 1.3.14 · Node.js 22 on Vercel · TypeScript 6 strict · Hono · ky · Drizzle ORM · postgres.js · Postgres 16-compatible SQL · Vercel Build Output API · AI SDK v6 · OpenRouter · Zod · Biome · Turbo.

<!-- HARDPROBLEMS -->

## Hard problems solved

This is a finance app, so the bar is *the numbers are never wrong and nothing double-logs.* Most of the engineering went into guaranteeing that under real-world failure modes.

**Money correctness by construction.** All money is stored and summed as integer centavos — there is no float in the money path. The LLM never computes amounts; it extracts a raw token (`"25k"`, `"1.5k"`, `"180.50"`) and a single parser converts it with exact integer math (property-tested, and SQL aggregates are range-checked back into JS via `toSafeCentavos`). Conversion to fractional pesos happens only at display (`formatPHP`); the internal pace/ratio analytics divide centavos but re-round to integer centavos.

**Crash-safe, pooler-safe inbound handling.** The webhook runs a **three-phase handler that holds no database connection across the multi-second LLM call**: a short transaction claims a dedup marker, the agent runs while *buffering* its writes (no connection held), then a second short transaction flushes all writes and completes the marker atomically. Holding a pooled connection across an LLM round-trip is an anti-pattern that pins backends and risks idle-in-transaction termination — this design avoids it entirely.

**Exactly-once under concurrent redelivery.** Webhook redelivery is a fact of life. Dedup is a single atomic `INSERT … ON CONFLICT DO UPDATE … WHERE stale` keyed on the message id, with a TTL: a true duplicate or an in-flight sibling is skipped, while a marker stranded by a crash is safely re-processed. Two concurrent deliveries can never both proceed.

**Same-message corrections that never clobber history.** "grab 180, no make it 200" in one message must edit the *just-logged* entry — not an unrelated historical row. The edit/delete path forward-replays the in-turn write buffer to target the correct row, and falls back to a stable snapshot id (replay-safe across retries) only when the turn logged nothing. Adversarially reviewed and regression-tested.

**Resilient real-model inference.** The agent routes every production call through OpenRouter on a free, tool-capable GPT OSS model (`openai/gpt-oss-120b:free` by default). `OPENROUTER_MODEL` can rotate that single live model, but the app rejects non-`:free` ids and no longer sends fallback-model presets. The call is wrapped in jittered backoff and a hard time budget so a slow run aborts *cleanly* instead of letting the platform hard-kill the request and strand state. If OpenRouter reports a different served model, Andy logs it loudly. The per-message token footprint was profiled and roughly halved.

**Observability + graceful degradation.** Every run emits one structured JSON line (tokens, steps, tool calls). Failures map to honest user replies ("too many at once, give me a sec" vs "out of credits") rather than a generic error, and a throttled message is always retryable, never silently dropped.

## Project status

This is a personal, single-user project. Running it live requires the author's own Sendblue account, a TCP/session Postgres database (e.g. Neon direct/session, Supabase direct, or local Postgres), and an OpenRouter key, so it's intended to be **read as an engineering showcase** rather than cloned and run. The correctness-critical core (money math, time/timezone, dedup, DB writes, agent tool logic, budget/goal/memory/recurring behavior) is fully unit-tested without any provider accounts; DB integration tests run only when `TEST_DATABASE_URL` points at real Postgres.

```bash
bun install
bun run typecheck   # tsc --noEmit across all packages
bun run lint        # Biome
bun run lint:no-excuse # repo-specific safety lint (catch handling, non-null assertions, etc.)
bun test            # 600+ tests (unit; DB-integration suite is gated on TEST_DATABASE_URL)
bun run build       # production Vercel bundle (Build Output API)
bun run ci:local    # full gate incl. DB integration tests vs ephemeral Postgres (needs Docker)
```

> `ci:local` runs the same checks as `.github/workflows/ci.yml` (typecheck · lint · unit + gated
> DB-layer integration suite · build) against a throwaway Postgres container. Use it as the
> dependable local green-checkmark; the GitHub Actions workflow runs the same gate when Actions is
> enabled for the repo.

## Contributing & community

It's a personal showcase, but issues, questions, and small PRs are welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md) for the dev loop and coding standards (notably the
money-correctness invariants), [SECURITY.md](./SECURITY.md) to report a vulnerability privately, and
the [Code of Conduct](./CODE_OF_CONDUCT.md). Please don't open issues asking for help deploying your
own instance — the project isn't designed for external deployment.

## License

[MIT](./LICENSE) © ndycode
