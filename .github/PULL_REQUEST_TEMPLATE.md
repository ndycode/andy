<!-- thanks for the PR. keep it focused, say what changed, and show the checks. -->

## what changed

<!-- what did you change, and why? link an issue if there is one. -->

## verification

<!-- paste the commands you ran. no mystery green checks. -->

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run lint:no-excuse`
- [ ] `bun test`
- [ ] `bun run build`
- [ ] `bun run ci:local`, or explain why Docker/DB integration was not available

## money rails

- [ ] no floats in the money path, amounts stay integer centavos
- [ ] dedup and the three-phase handler still hold
- [ ] no DB connection is held across the model call
- [ ] `@repo/shared` stays free of `@repo/db` and `@repo/ai`
- [ ] tests cover the behavior or regression
- [ ] not applicable
