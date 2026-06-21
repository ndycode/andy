import type { ToolResult } from "./src/tool-test-harness";

export function firstResult(results: readonly ToolResult[]): ToolResult {
  const [result] = results;
  if (!result) throw new Error("missing tool result");
  return result;
}

export function boolValue(result: ToolResult, key: string): boolean | null {
  const value = result[key];
  return typeof value === "boolean" ? value : null;
}

export function stringValue(result: ToolResult, key: string): string | null {
  const value = result[key];
  return typeof value === "string" ? value : null;
}

export function arrayValue(result: ToolResult, key: string): readonly unknown[] {
  const value = result[key];
  return Array.isArray(value) ? value : [];
}

export function includesJsonText(value: unknown, text: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(text.toLowerCase());
}
