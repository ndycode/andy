import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

/**
 * Model strategy (see the fallback audit + migration plan). The Vercel AI Gateway free-tier rate
 * limit is ACCOUNT-WIDE — applied before model routing — so switching models *within* the gateway
 * (and even BYOK through it) does NOT escape a GatewayRateLimitError. The only $0 escape is calling
 * a provider DIRECTLY, which hits that provider's own separate free quota pool.
 *
 *  Tier 0 — gateway: Haiku (preferred quality) with in-request fallbacks to Gemini/DeepSeek. Those
 *           cover PROVIDER outages (5xx/overload), not the account throttle.
 *  Tier 1 — direct Google Gemini (own free quota: ~10 RPM / 250 RPD on flash).
 *  Tier 2 — direct Groq (own free quota: ~30 RPM / 14,400 RPD, no card) — deepest burst headroom.
 *
 * Each direct tier is null unless its key is set, so behavior is unchanged without the env var
 * (dev/test). agent.ts appends the non-null tiers to the retry chain in order; they fire only after
 * the gateway tier rate-limits + backs off.
 */
export const MODEL_ID = "anthropic/claude-haiku-4.5";

/**
 * In-request gateway fallbacks for provider faults. gemini-2.5-flash (GA-stable; the 3-preview has
 * tool-call bugs) then deepseek-v3.2 (independent provider). Both cheaper than Haiku.
 */
export const GATEWAY_FALLBACKS = ["google/gemini-2.5-flash", "deepseek/deepseek-v3.2"];

/** Tier 1: direct Google key → separate free quota pool that bypasses the gateway throttle. */
export const directGoogle: LanguageModel | null = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  ? createGoogleGenerativeAI()("gemini-2.5-flash")
  : null;

/** Tier 2: direct Groq key → another separate free pool (highest daily headroom, no card).
 * gpt-oss-120b, NOT llama-3.3-70b: live-tested against the real 18-tool schema, llama failed with
 * "Failed to call a function" while gpt-oss-120b tool-calls cleanly (log, multi-entry, and reads). */
export const directGroq: LanguageModel | null = process.env.GROQ_API_KEY
  ? createGroq()("openai/gpt-oss-120b")
  : null;
