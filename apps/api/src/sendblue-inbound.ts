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
/**
 * Constant-time check of the self-minted URL token. Exported so the route can authenticate BEFORE
 * reading/parsing the request body — an unauthenticated request then does zero parse work. Reads
 * through validated env so a missing/empty value fails loudly instead of coercing to "" and 401ing
 * every inbound request.
 */
export function isValidWebhookToken(urlToken: string | null): boolean {
  const expected = env.WEBHOOK_URL_TOKEN;
  return Boolean(expected && urlToken && constantTimeEqual(urlToken, expected));
}

export function parseInbound(urlToken: string | null, body: unknown): InboundMessage | null {
  if (!isValidWebhookToken(urlToken)) return null;

  if (!isRecord(body)) return null;

  const b = body;
  if (b.is_outbound === true) return null;
  if (b.status !== "RECEIVED") return null;

  const phone = typeof b.number === "string" ? b.number : undefined;
  // Trim so a whitespace-only message ("   ") is rejected here instead of driving an empty agent run.
  const text = typeof b.content === "string" ? b.content.trim() : "";
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
