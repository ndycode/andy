import { env } from "@repo/shared/env";
import { constantTimeEqual } from "@repo/shared/security";

export interface InboundMessage {
  readonly phone: string;
  readonly text: string;
  readonly messageId: string | undefined;
}

/**
 * Parse + authenticate an inbound Sendblue webhook.
 * Sendblue has no inbound signing secret, so we authenticate via a self-minted
 * token embedded in the registered webhook URL: /webhooks/sendblue?t=<WEBHOOK_URL_TOKEN>.
 * Returns null if the token is missing/wrong, or if this is not a received inbound text.
 */
export function parseInbound(urlToken: string | null, body: unknown): InboundMessage | null {
  // Read through validated env so a missing/empty value fails loudly instead of silently
  // coercing to "" and rejecting every inbound request.
  const expected = env.WEBHOOK_URL_TOKEN;
  if (!expected || !urlToken || !constantTimeEqual(urlToken, expected)) return null;

  if (!isRecord(body)) return null;

  const b = body;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
