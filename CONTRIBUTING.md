# Contributing to Andy

Thanks for your interest! Andy is a **personal, single-user showcase project**, so the scope is
intentionally narrow — but bug reports, questions, and small, focused PRs are genuinely welcome.

Before investing time in a large change, please open an issue to discuss it. The project is not
designed to be deployed by others, so PRs aimed at generalizing it for multi-tenant or self-hosted
use are out of scope.

## Prerequisites

- [Bun](https://bun.sh) `1.3.14` (the version pinned in `package.json` → `packageManager`)
- [Docker](https://www.docker.com/) — only for the Postgres-backed integration tests (`bun run ci:local`)

No other accounts (Sendblue, OpenRouter, a database) are needed to build, lint, typecheck, or run the
unit suite — the correctness-critical core is fully tested without them.

## Dev loop

```bash
bun install

bun run typecheck      # tsc --noEmit across every package (+ api/ and scripts/)
bun run lint           # Biome (format + lint)
bun run lint:fix       # auto-fix the safe lint/format findings
bun run lint:no-excuse # repo-specific custom linter (no swallowed catches, no magic literals, …)
bun test               # unit suite; the DB-integration suite is gated on TEST_DATABASE_URL
bun run build          # production Vercel bundle (Build Output API)

bun run ci:local       # the FULL gate, incl. integration tests vs an ephemeral Postgres (needs Docker)
```

`bun run ci:local` mirrors the checks in `.github/workflows/ci.yml`. Run it before opening a PR — it's
the dependable green checkmark.

## Coding standards

- **Formatting & lint:** [Biome](https://biomejs.dev/). Double quotes, semicolons, 2-space indent,
  100-col width — all enforced by `biome.json`. Run `bun run lint:fix`; don't hand-format.
- **TypeScript:** strict mode, plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. No `any`,
  no non-null assertions in app code, no unsafe casts at trust boundaries.
- **No-excuse rules:** the custom linter (`scripts/typescript/`) forbids empty/blind `catch` blocks
  (narrow with `instanceof` or rethrow), unexplained magic literals, and stray non-null assertions.
  If a rule genuinely must be bypassed, use an explicit `// no-excuse-ok: <rule>` annotation with a
  reason — don't disable the linter.
- **Tests:** write behavior-focused tests with `bun test`. Pure logic is unit-tested directly; the DB
  layer has `*.integration.test.ts` suites that run against real Postgres (gated on
  `TEST_DATABASE_URL`). New behavior needs a test; bug fixes need a regression test.
- **Minimal-dependency core:** `@repo/shared` carries only `zod` + `@t3-oss/env-core` and must not
  import from `@repo/db`/`@repo/ai`. The package graph is acyclic and layered — `@repo/shared` (no
  internal deps) ← `@repo/db` ← `@repo/ai` ← `apps/api` — where higher layers may also depend on
  lower ones directly.

## Invariants you must not break

This is a finance app — *the numbers are never wrong and nothing double-logs.* If your change touches
these areas, preserve the invariants (and the tests that guard them):

- **Money is integer centavos end-to-end.** No floating point in the money path. The LLM never
  computes amounts — it emits a raw token (`"25k"`, `"180.50"`) and a single parser converts it with
  exact integer math. Fractional pesos appear only at display (`formatPHP`).
- **Exactly-once under redelivery.** The three-phase inbound handler holds **no DB connection across
  the LLM call**: claim a dedup marker → run the agent buffering writes → flush + complete the marker
  atomically in one short, self-fencing transaction. Don't introduce a connection held across the
  model round-trip, and don't weaken the marker self-fence.
- **Corrections target the just-logged row**, never an unrelated historical one.

## Migrations

Schema changes use Drizzle. Generate with `bun run --filter @repo/db db:generate` and review the SQL.
**Footgun:** Postgres forbids using a freshly-added enum label in the same transaction that adds it,
and the migrator wraps each file in one transaction — so adding a category requires **two** migration
files (one to `ALTER TYPE … ADD VALUE`, a later one to reference it). See the note atop
`packages/db/src/schema.ts`.

## Commit & PR conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`,
  `refactor:`, `perf:`, `docs:`, `test:`. Keep commits atomic and the gate green at each one.
- In the PR, describe the change and the verification you ran. The PR template has a checklist.

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
