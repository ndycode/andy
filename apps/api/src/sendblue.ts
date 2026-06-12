/** Sendblue adapter. Inbound parsing + outbound REST. Verified header/field names (C5). */

import { env } from "@repo/shared/env";

const BASE = "https://api.sendblue.com/api";

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": env.SENDBLUE_API_KEY,
    "sb-api-secret-key": env.SENDBLUE_API_SECRET,
  };
}

export interface InboundMessage {
  phone: string;
  text: string;
  messageId: string | undefined;
}

/**
 * Parse + authenticate an inbound Sendblue webhook.
 * Sendblue has NO inbound signing secret (C5), so we authenticate via a self-minted
 * token embedded in the registered webhook URL: /webhooks/sendblue?t=<WEBHOOK_URL_TOKEN>.
 * Returns null if the token is missing/wrong, or if this isn't a received inbound text.
 */
export function parseInbound(urlToken: string | null, body: unknown): InboundMessage | null {
  const expected = process.env.WEBHOOK_URL_TOKEN ?? "";
  if (!expected || !urlToken || !constantTimeEqual(urlToken, expected)) return null;

  const b = (body ?? {}) as Record<string, unknown>;
  if (b.is_outbound === true) return null;
  if (b.status !== "RECEIVED") return null;

  const phone = typeof b.number === "string" ? b.number : undefined;
  const text = typeof b.content === "string" ? b.content : "";
  if (!phone || !text) return null;

  return {
    phone,
    text,
    messageId: typeof b.message_handle === "string" ? b.message_handle : undefined,
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
  await post("/send-typing-indicator", { number: phone }).catch(() => {});
}

/** Tapback reaction on an inbound message (iMessage only). Best-effort. */
export async function sendReaction(
  phone: string,
  reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question",
  messageHandle?: string,
): Promise<void> {
  if (!messageHandle) return; // reactions require the inbound Apple GUID
  await post("/send-reaction", {
    number: phone,
    from_number: env.SENDBLUE_FROM_NUMBER,
    message_handle: messageHandle,
    reaction,
  }).catch(() => {});
}

async function post(path: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`Sendblue ${path} ${res.status}: ${await res.text().catch(() => "")}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
