<!-- Thanks for contributing! Keep PRs focused. See CONTRIBUTING.md. -->

## What & why

<!-- What does this change, and why? Link any related issue (e.g. "Closes #12"). -->

## Verification

<!-- What did you run? Paste relevant output if useful. -->

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` and `bun run lint:no-excuse` pass
- [ ] `bun test` passes
- [ ] `bun run build` succeeds
- [ ] `bun run ci:local` passes (full gate incl. DB integration — needs Docker), or N/A
- [ ] Added/updated tests for the change (behavior or regression)

## Invariants

- [ ] No floating point introduced into the money path (amounts stay integer centavos)
- [ ] Dedup / three-phase handler guarantees preserved (no DB connection held across the LLM call)
- [ ] `@repo/shared` stays dependency-free and doesn't import `@repo/db`/`@repo/ai`
- [ ] N/A — this PR doesn't touch those areas
