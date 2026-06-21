import { describe, expect, test } from "bun:test";
import {
  hasSummaryForWeek as rootHasSummaryForWeek,
  reapSummaryRuns as rootReapSummaryRuns,
  recordSummary as rootRecordSummary,
} from "./index";
import { hasSummaryForWeek, reapSummaryRuns, recordSummary } from "./summary-queries";

describe("summary-queries boundary", () => {
  test("owns weekly summary idempotency helpers behind the package root", () => {
    expect(hasSummaryForWeek).toBe(rootHasSummaryForWeek);
    expect(recordSummary).toBe(rootRecordSummary);
    expect(reapSummaryRuns).toBe(rootReapSummaryRuns);
  });
});
