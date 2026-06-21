#!/usr/bin/env bun
export type { RuleId, Violation } from "./no-excuse-core";
export { checkSource } from "./no-excuse-core";

import { runCli } from "./no-excuse-cli";

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
