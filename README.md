# Andy — an iMessage personal finance assistant

[![CI](https://github.com/ndycode/andy/actions/workflows/ci.yml/badge.svg)](https://github.com/ndycode/andy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)

> Text your money in plain language. An AI agent logs it, answers questions from real data, and nudges you — all over iMessage.

```
you  ▸ grab 180, lunch jollibee 250, sweldo 25k
andy ▸ logged ₱180 transport, ₱250 food, and ₱25,000 income 🫡
you  ▸ am i broke?
andy ▸ you're at ₱2,408 net this month. you get paid the 15th, so you're fine — but those grabs are adding up 👀
```

Andy is a single-user, free-tier, serverless finance assistant. You talk to it like a friend; it turns natural language into typed financial transactions, persists them with exact integer-centavo money math, and answers questions from real SQL aggregation — never from chat history. It's built for the Philippines (PHP, Asia/Manila, GCash/sweldo idioms) and runs at ~$0/month.

**300+ tests · TypeScript strict · typecheck + lint + test + build green in CI.**

---

## Architecture

A Bun workspaces monorepo, deployed serverless on Vercel.

```
iMessage ─▶ Sendblue webhook ─▶ Hono API (Vercel, sin1)
                                     │
                  ┌──────────────────┼───────────────────┐
                  ▼                  ▼                   ▼
          packages/shared     packages/ai          packages/db
          money · time ·      AI SDK v6 agent      Drizzle + Neon
          allowlist ·         27 finance tools     atomic dedup ·
          budget · errors     multi-model chain    short txns
```

| Package | Responsibility |
|---|---|
| `packages/shared` | Pure, dependency-free core: integer-centavo money math, Asia/Manila time, E.164 allowlist, budget logic, env validation, structured logging |
| `packages/db` | Drizzle schema + queries on Neon Postgres. Atomic claim/flush dedup, idempotent writes, no N+1 |
| `packages/ai` | AI SDK v6 `ToolLoopAgent` with 27 finance tools, a buffered-write pattern, and a multi-provider fallback chain |
| `apps/api` | Hono webhook + cron. Three-phase inbound handler, Sendblue adapter, proactive nudges |

**Stack:** Bun · TypeScript (strict) · Hono · Drizzle ORM · Neon Postgres · Vercel (Build Output API) · AI SDK v6 · Biome · Turbo.

<!-- HARDPROBLEMS -->

## Hard problems solved

This is a finance app, so the bar is *the numbers are never wrong and nothing double-logs.* Most of the engineering went into guaranteeing that under real-world failure modes.

**Money correctness by construction.** All money is stored and summed as integer centavos — there is no float in the money path. The LLM never computes amounts; it extracts a raw token (`"25k"`, `"1.5k"`, `"180.50"`) and a single parser converts it with exact integer math (property-tested, and SQL aggregates are range-checked back into JS via `toSafeCentavos`). Conversion to fractional pesos happens only at display (`formatPHP`); the internal pace/ratio analytics divide centavos but re-round to integer centavos.

**Crash-safe, pooler-safe inbound handling.** The webhook runs a **three-phase handler that holds no database connection across the multi-second LLM call**: a short transaction claims a dedup marker, the agent runs while *buffering* its writes (no connection held), then a second short transaction flushes all writes and completes the marker atomically. Holding a pooled connection across an LLM round-trip is an anti-pattern that pins backends and risks idle-in-transaction termination — this design avoids it entirely.

**Exactly-once under concurrent redelivery.** Webhook redelivery is a fact of life. Dedup is a single atomic `INSERT … ON CONFLICT DO UPDATE … WHERE stale` keyed on the message id, with a TTL: a true duplicate or an in-flight sibling is skipped, while a marker stranded by a crash is safely re-processed. Two concurrent deliveries can never both proceed.

**Same-message corrections that never clobber history.** "grab 180, no make it 200" in one message must edit the *just-logged* entry — not an unrelated historical row. The edit/delete path forward-replays the in-turn write buffer to target the correct row, and falls back to a stable snapshot id (replay-safe across retries) only when the turn logged nothing. Adversarially reviewed and regression-tested.

**Resilient multi-model inference.** The agent routes through OpenRouter on a free, tool-capable primary model (`openai/gpt-oss-120b`, verified against the full tool schema) with native cross-model fallback to other free models — wrapped in jittered backoff, a hard time budget so a slow run aborts *cleanly* (never a platform hard-kill that strands state), and error classification that skips a dead model instead of dead-ending. The per-message token footprint was profiled and roughly halved.

**Observability + graceful degradation.** Every run emits one structured JSON line (tokens, steps, tool calls). Failures map to honest user replies ("too many at once, give me a sec" vs "out of credits") rather than a generic error, and a throttled message is always retryable, never silently dropped.

## Project status

This is a personal, single-user project. Running it live requires the author's own Sendblue, Neon, and OpenRouter accounts, so it's intended to be **read as an engineering showcase** rather than cloned and run. The correctness-critical core (money math, time/timezone, dedup logic, agent tool logic) is fully unit- and integration-tested without any of those accounts.

```bash
bun install
bun run typecheck   # tsc --noEmit across all packages
bun run lint        # Biome
bun test            # 300+ tests
bun run build       # production Vercel bundle (Build Output API)
bun run ci:local    # full gate incl. DB integration tests vs ephemeral Postgres (needs Docker)
```

> `ci:local` runs the same checks as `.github/workflows/ci.yml` (typecheck · lint · unit + gated
> DB-layer integration suite · build) against a throwaway Postgres container. Use it as the
> dependable local green-checkmark; the GitHub Actions workflow runs the same gate when Actions is
> enabled for the repo.

## License

MIT © ndycode

