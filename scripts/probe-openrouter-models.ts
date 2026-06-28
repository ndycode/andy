#!/usr/bin/env bun
/**
 * Deny-probe for OpenRouter free models (audit H2).
 *
 * "Exists + advertises tools" on the models endpoint does NOT mean a model can actually serve under
 * `provider.data_collection: "deny"` — stricter than Andy's current production route. A model whose
 * only free endpoint trains on data is 404'd under deny and silently drops out of the served fallback
 * chain. This script makes a REAL completion request per candidate, under deny, with a tiny tool, and
 * reports which ids genuinely route + tool-call if you want to reintroduce that stricter policy.
 *
 * Usage:  OPENROUTER_API_KEY=... bun run scripts/probe-openrouter-models.ts
 * Reads the key from the environment (the same one the app uses); makes one cheap call per candidate.
 *
 * Verdict legend:
 *   OK          200 + emitted a tool call    -> deny-routable AND tool-capable (good chain member)
 *   NO-TOOLCALL 200 but no tool call         -> routes under deny but failed the tool schema
 *   RATELIMIT   429                          -> deny-routable (endpoint exists), just throttled now
 *   EXCLUDED    404 "no endpoints…policy"    -> NO deny-compatible endpoint; do NOT put in the chain
 *   ERROR       anything else                -> see the message
 */

// Current chain (keep in sync with packages/ai/src/model.ts) plus extra free tool-callers to consider
// as deny-compatible replacements. Edit freely — this is a scratch list for the probe.
const CANDIDATES: readonly string[] = [
  "openai/gpt-oss-120b:free", // current MODEL_ID
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3.1:free",
  "google/gemini-2.0-flash-exp:free",
  "mistralai/mistral-small-3.2-24b-instruct:free",
];

interface ProbeResult {
  readonly model: string;
  readonly verdict: "OK" | "NO-TOOLCALL" | "RATELIMIT" | "EXCLUDED" | "ERROR";
  readonly detail: string;
}

async function probe(model: string, apiKey: string): Promise<ProbeResult> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Call the ping tool now." }],
        tools: [
          {
            type: "function",
            function: {
              name: "ping",
              description: "Replies pong. Call it.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 64,
        provider: { data_collection: "deny" },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const bodyText = await res.text();
    if (res.status === 429) return { model, verdict: "RATELIMIT", detail: "429 (endpoint exists)" };
    if (res.status === 404 || /no endpoints found matching your data policy/i.test(bodyText)) {
      return { model, verdict: "EXCLUDED", detail: `${res.status}: no deny-compatible endpoint` };
    }
    if (!res.ok)
      return { model, verdict: "ERROR", detail: `${res.status}: ${bodyText.slice(0, 160)}` };

    const json = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
    };
    const toolCalls = json.choices?.[0]?.message?.tool_calls;
    return toolCalls && toolCalls.length > 0
      ? { model, verdict: "OK", detail: "200 + tool call" }
      : { model, verdict: "NO-TOOLCALL", detail: "200 but no tool call" };
  } catch (err) {
    return { model, verdict: "ERROR", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<number> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "OPENROUTER_API_KEY is not set. Run: OPENROUTER_API_KEY=... bun run scripts/probe-openrouter-models.ts",
    );
    return 2;
  }
  console.log(`Probing ${CANDIDATES.length} candidates under provider.data_collection:"deny"…\n`);
  // Sequential to be polite to the free tier and keep output readable.
  for (const model of CANDIDATES) {
    const r = await probe(model, apiKey);
    console.log(`${r.verdict.padEnd(11)} ${r.model}  —  ${r.detail}`);
  }
  console.log(
    "\nPick one `:free` OPENROUTER_MODEL from the OK rows.\nDo NOT use EXCLUDED ids — they cannot serve under deny.",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
