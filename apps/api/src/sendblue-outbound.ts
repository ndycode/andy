import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import ky, { HTTPError, NetworkError, TimeoutError } from "ky";

const BASE = "https://api.sendblue.com/api";
const SEND_TIMEOUT_MS = 10_000;

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": env.SENDBLUE_API_KEY,
    "sb-api-secret-key": env.SENDBLUE_API_SECRET,
  };
}

export async function sendMessage(phone: string, content: string): Promise<void> {
  await post("/send-message", {
    number: phone,
    from_number: env.SENDBLUE_FROM_NUMBER,
    content,
  });
}

export async function sendTyping(phone: string): Promise<void> {
  await sendBestEffort("sendblue.typing.error", () =>
    post("/send-typing-indicator", { number: phone, from_number: env.SENDBLUE_FROM_NUMBER }),
  );
}

/** Tapback reaction on an inbound message (iMessage only). Best-effort. */
export async function sendReaction(
  phone: string,
  reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question",
  messageHandle?: string,
): Promise<void> {
  if (!messageHandle) return;
  await sendBestEffort("sendblue.reaction.error", () =>
    post("/send-reaction", {
      number: phone,
      from_number: env.SENDBLUE_FROM_NUMBER,
      message_handle: messageHandle,
      reaction,
    }),
  );
}

async function sendBestEffort(event: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    log.error(event, errInfo(err));
  }
}

async function post(path: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await ky.post(path, {
      prefix: BASE,
      headers: authHeaders(),
      json: payload,
      retry: { limit: 0 },
      timeout: SEND_TIMEOUT_MS,
    });
  } catch (err) {
    if (isTimeoutLike(err)) {
      throw new Error(`Sendblue ${path} timed out after 10s`);
    }
    if (err instanceof NetworkError) {
      if (isTimeoutLike(err.cause)) {
        throw new Error(`Sendblue ${path} timed out after 10s`);
      }
      if (err.cause instanceof Error) throw err.cause;
    }
    if (err instanceof HTTPError) {
      throw new Error(`Sendblue ${path} ${err.response.status}: ${formatErrorBody(err.data)}`);
    }
    throw err;
  }
}

function isTimeoutLike(err: unknown): boolean {
  return (
    err instanceof TimeoutError ||
    (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
  );
}

function formatErrorBody(body: unknown): string {
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  if (typeof body === "number" || typeof body === "boolean" || typeof body === "bigint") {
    return String(body);
  }
  return JSON.stringify(body);
}
