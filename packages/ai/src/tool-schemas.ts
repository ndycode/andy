import { z } from "zod";

export const amountSchema = z
  .string()
  .describe('Amount token exactly as written, e.g. "180", "25k". No conversion.');

// Category as a plain string (valid list lives once in the system prompt, not repeated per-tool —
// saves re-sending the 9-value enum across ~8 tools every step). coerceCategory() hardens it
// server-side on every write path, so a bad value safely becomes "Other".
export const categorySchema = z.string().describe("One of the listed categories.");

// Optional backdate: the LLM resolves natural language ("yesterday", "last friday") against the
// <today> block into YYYY-MM-DD; validateLogDate() hardens it server-side (real date, not future,
// not absurdly old). Omitted → today.
export const dateSchema = z
  .string()
  .optional()
  .describe("Date the expense/income happened, YYYY-MM-DD. Omit for today.");

// Optional historical month for read tools, resolved by the LLM to YYYY-MM. Omitted → this month.
export const monthSchema = z
  .string()
  .optional()
  .describe("Month to query as YYYY-MM (e.g. '2026-05'). Omit for the current month.");
