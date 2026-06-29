<!-- thanks for the PR. keep it focused, say what changed, and show the checks. -->

## what changed

<!-- what did you change, and why? link an issue if there is one. -->

## verification

<!-- paste the commands you ran. -->

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `cargo xtask ci`
- [ ] DB integration with `TEST_DATABASE_URL`, or explain why Postgres was not available

## correctness checks

- [ ] no floats in the money path, amounts stay integer centavos
- [ ] dedup and the three-phase handler still hold
- [ ] no DB connection is held across the model call
- [ ] `andy_shared` stays free of `andy_db` and `andy_ai`
- [ ] tests cover the behavior or regression
- [ ] not applicable
