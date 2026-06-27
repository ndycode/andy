/**
 * Minimal structured logger. Emits one JSON object per line to stdout/stderr so Vercel's log
 * drain can index by field (level, event, msgId) instead of grepping free-form strings.
 * No dependency; intentionally tiny.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  let line: string;
  try {
    line = JSON.stringify({ level, event, t: new Date().toISOString(), ...fields });
    // A total logger must swallow ALL serialization failures so logging can never throw into the
    // caller; narrowing/rethrowing would defeat that. no-excuse-ok: catch
  } catch {
    // A field was unserializable (circular ref, BigInt). Emit a minimal safe line (base fields only,
    // guaranteed serializable) instead of crashing the request/cron that was merely trying to log.
    line = JSON.stringify({
      level,
      event,
      t: new Date().toISOString(),
      logError: "unserializable fields dropped",
    });
  }
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

/** Normalize an unknown thrown value to a compact, loggable shape. */
export function errInfo(
  err: unknown,
  opts?: { stack?: boolean },
): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    // Stack is opt-in: expected/handled errors (rate limits, Sendblue non-200) stay terse, while
    // truly-unexpected boundaries (request onError, cron.error) can ask for the stack — the single
    // most useful field when diagnosing an unforeseen production failure from the log drain.
    return opts?.stack && err.stack
      ? { name: err.name, message: err.message, stack: err.stack }
      : { name: err.name, message: err.message };
  }
  return { name: "NonError", message: String(err) };
}
