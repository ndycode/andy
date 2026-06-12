/**
 * Minimal structured logger. Emits one JSON object per line to stdout/stderr so Vercel's log
 * drain can index by field (level, event, msgId) instead of grepping free-form strings.
 * No dependency; intentionally tiny.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, t: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

/** Normalize an unknown thrown value to a compact, loggable shape. */
export function errInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "NonError", message: String(err) };
}
