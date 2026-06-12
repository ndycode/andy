/**
 * Map an error to the user-facing reply Andy sends when a turn fails. Pure + tested because this
 * is the surface the user actually sees on failure, and the three cases need different advice:
 *  - hard credit/quota limit (HTTP 402, balance depleted) → resending won't help; say so.
 *  - burst rate limit (429/too many) → transient; tell them to pause and resend.
 *  - everything else → generic apology.
 */
export function failureReply(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const isHardLimit =
    /\b402\b|payment required|insufficient|upgrade to|out of credit|balance/i.test(msg);
  if (isHardLimit) {
    return "i'm out of credits for now 😬 nothing's broken — ping the owner to top up and i'll be back.";
  }
  const isRateLimit = /rate.?limit|429|too many requests|quota/i.test(msg);
  if (isRateLimit) {
    return "too many at once 😅 give me a few seconds and resend that last one.";
  }
  return "sorry, something went wrong — try again in a sec.";
}
