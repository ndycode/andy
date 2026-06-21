import type { ToolContext } from "./context";
import { type AnalysisReadToolDeps, buildAnalysisReadTools } from "./read-analysis-tools";
import type { BasicReadDeps } from "./read-basic-actions";
import { buildBasicReadTools } from "./read-basic-tools";

export type ReadToolDeps = {
  readonly basic?: BasicReadDeps;
  readonly analysis?: AnalysisReadToolDeps;
};

export function buildReadTools(ctx: ToolContext, deps: ReadToolDeps = {}) {
  return {
    ...buildBasicReadTools(ctx, deps.basic),
    ...buildAnalysisReadTools(ctx, deps.analysis),
  };
}
