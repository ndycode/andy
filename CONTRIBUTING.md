# contributing

thanks for the interest. andy is a personal, single-user showcase, so the scope is narrow. bug reports, questions, and small PRs are welcome. hosted-product and multi-tenant changes are out of scope.

if the change is large, open an issue first so the scope is clear.

## what you need

- [Bun](https://bun.sh) `1.3.14`, pinned in `package.json`
- [Docker](https://www.docker.com/), only for `bun run ci:local` and real Postgres integration tests

you do not need Sendblue, OpenRouter, or a live database for typecheck, lint, build, or the unit suite.

## dev loop

```bash
bun install

bun run typecheck      # tsc --noEmit across every package, api, and scripts
bun run lint           # Biome
bun run lint:fix       # safe lint and format fixes
bun run lint:no-excuse # custom repo safety lint
bun test               # 600+ tests, DB integration gated by TEST_DATABASE_URL
bun run build          # production Vercel Build Output API bundle

bun run ci:local       # full gate with ephemeral Postgres, needs Docker
```

`bun run ci:local` mirrors `.github/workflows/ci.yml`. run it before a PR when Docker is available.

## code style

- **formatting:** Biome owns it. double quotes, semicolons, 2-space indent, 100-column width. run `bun run lint:fix`.
- **TypeScript:** strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. no `any`, no casual non-null assertions, no unsafe casts at trust boundaries.
- **no-excuse lint:** empty catches, swallowed errors, unexplained magic literals, and stray non-null assertions get blocked. if a bypass is truly needed, use `// no-excuse-ok: <rule>` with the reason.
- **tests:** behavior first. new behavior gets a test. bug fixes get a regression test. DB integration lives in `*.integration.test.ts` and runs only with `TEST_DATABASE_URL`.
- **package graph:** keep it layered. `@repo/shared` has no internal deps. `@repo/db` can use shared. `@repo/ai` can use db and shared. `apps/api` sits at the edge.

## invariants

these correctness rules matter most.

- **money stays integer centavos.** no floats in the money path. the model passes raw text like `"25k"` or `"180.50"`, then the parser converts it once.
- **one message logs once.** the claim/flush marker is the source of truth for redelivery. true duplicate, skip. stale crash marker, retry safely.
- **no DB connection across the model call.** claim, release, run model, flush. do not pin a backend while waiting on OpenRouter.
- **corrections target the just-logged row.** "make that 200" must not edit some old transaction by accident.
- **answers come from tools.** money questions use SQL-backed reads. no chat-history guessing.

## migrations

schema changes use Drizzle.

```bash
bun run --filter @repo/db db:generate
```

review the SQL before committing it. Postgres enum changes are a footgun: adding a label and using it in the same migration file can fail because the migrator wraps the file in one transaction. add the enum value in one migration, reference it in a later one.

## commits and PRs

use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `perf:`, `docs:`, `test:`.

keep PRs focused. say what changed, why, and what you ran. if you touched money, dedup, DB writes, or the handler, call that out directly.

by contributing, you agree your work is licensed under [MIT](./LICENSE).
