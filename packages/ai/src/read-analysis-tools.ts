import type { ToolContext } from "./context";
import type { HistoryReadDeps } from "./read-history-actions";
import { buildHistoryReadTools } from "./read-history-tools";
import type { InsightReadDeps } from "./read-insight-actions";
import { buildInsightReadTools } from "./read-insight-tools";
import type { PaceReadDeps } from "./read-pace-actions";
import { buildPaceReadTools } from "./read-pace-tools";

export type AnalysisReadToolDeps = {
  readonly insight?: InsightReadDeps;
  readonly history?: HistoryReadDeps;
  readonly pace?: PaceReadDeps;
};

export function buildAnalysisReadTools(ctx: ToolContext, deps: AnalysisReadToolDeps = {}) {
  return {
    ...buildInsightReadTools(ctx, deps.insight),
    ...buildHistoryReadTools(ctx, deps.history),
    ...buildPaceReadTools(ctx, deps.pace),
  };
}
