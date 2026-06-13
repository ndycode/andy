import { generateText, type LanguageModel } from "ai";
import { MODEL_ID } from "./model";

/**
 * Render a proactive message in Andy's voice from a structured brief.
 *
 * Proactive messages (budget nudges, bill reminders, the weekly recap) used to be hard-coded
 * template strings — so the persona went silent in exactly the unprompted moments that make an
 * assistant feel alive. This runs one cheap, single-shot LLM call (no tools) to phrase the same
 * facts as a text from Andy. The caller passes a deterministic `fallback`; if the model errors or
 * rate-limits, we use it, so a proactive message is never dropped.
 */
const VOICE = `You are Andy, a witty, warm personal money assistant texting one user over iMessage.
Rewrite the given facts as ONE short iMessage (1-2 sentences), strictly lowercase, no em-dashes,
minimal emoji, no "not just X but Y". Keep every number EXACTLY as given; never invent figures.
Sound like a clever friend, supportive not preachy. Output only the message text.`;

export async function composeProactive(
  brief: string,
  fallback: string,
  model: LanguageModel = MODEL_ID,
): Promise<string> {
  try {
    const { text } = await generateText({
      model,
      system: VOICE,
      prompt: brief,
      // Bound this single-shot call. In the daily cron composeProactive runs in a loop (per budget
      // category + per due bill); without a timeout one hung LLM call would block the whole cron
      // until the platform wall-clock kill. On abort the catch below falls back to the deterministic
      // template — the proactive message is never dropped, just un-rephrased.
      abortSignal: AbortSignal.timeout(15_000),
    });
    const out = text.trim();
    if (out.length === 0) return fallback;
    // Money-correctness guard: the model is told to keep numbers exact, but "told" is not
    // "guaranteed". Reject any rephrase that introduces a figure not present in the source facts —
    // a wrong number in a finance message fails the bar. We check BOTH ₱-prefixed tokens and bare
    // multi-digit numbers (so a hallucinated "over by 9999 pesos" is caught too). Commas/decimals
    // are normalized so "₱5,000.00" and "5000" compare equal. On any mismatch, use the exact template.
    const figures = (s: string): Set<string> => {
      const out = new Set<string>();
      for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
        const norm = m[0].replace(/,/g, "").replace(/\.0+$/, "");
        if (norm.length > 0) out.add(norm);
      }
      return out;
    };
    const allowed = figures(`${brief} ${fallback}`);
    const numbersIntact = [...figures(out)].every((n) => allowed.has(n));
    return numbersIntact ? out : fallback;
  } catch {
    return fallback;
  }
}
