# contributing

andy is a personal, single-user showcase, so the scope is narrow. bug reports, questions, and small PRs are welcome. hosted-product and multi-tenant changes are out of scope.

if the change is large, open an issue first so the scope is clear.

## what you need

- Rust stable, pinned by `rust-toolchain.toml`
- Postgres only for DB integration tests

you do not need Sendblue, OpenRouter, or a live database for format, clippy, build, or the unit suite.

## dev loop

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask ci
```

DB integration tests are gated by `TEST_DATABASE_URL`:

```bash
TEST_DATABASE_URL=postgres://... cargo test --workspace --features andy_db/db-integration
```

## code style

- **formatting:** rustfmt owns it. run `cargo fmt --all`.
- **linting:** clippy runs with `-D warnings`.
- **unsafe:** runtime crates deny unsafe code.
- **tests:** behavior first. new behavior gets a test. bug fixes get a regression test. DB integration tests require `TEST_DATABASE_URL`.
- **crate graph:** keep it layered. `andy_shared` has no internal deps. `andy_db` can use shared. `andy_ai` can use db and shared. `andy_api` sits at the edge.

## invariants

these correctness rules matter most.

- **money stays integer centavos.** no floats in the money path. the model passes raw text like `"25k"` or `"180.50"`, then the parser converts it once.
- **one message logs once.** the claim/flush marker is the source of truth for redelivery. true duplicate, skip. stale crash marker, retry safely.
- **no DB connection across the model call.** claim, release, run model, flush. do not pin a backend while waiting on OpenRouter.
- **corrections target the just-logged row.** "make that 200" must not edit some old transaction by accident.
- **answers come from tools or SQL.** no chat-history guessing for money facts.

## migrations

schema history remains in `packages/db/migrations`. review SQL before committing it. Postgres enum changes are a footgun: adding a label and using it in the same migration file can fail because the migrator wraps the file in one transaction. add the enum value in one migration, reference it in a later one.

## commits and PRs

use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `perf:`, `docs:`, `test:`.

keep PRs focused. say what changed, why, and what you ran. if you touched money, dedup, DB writes, or the handler, call that out directly.

by contributing, you agree your work is licensed under [MIT](./LICENSE).
