import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Validated environment. Replaces scattered `process.env.X ?? ""` reads that silently turned a
 * missing secret into an empty string (an empty WEBHOOK_URL_TOKEN made every inbound request 401).
 *
 * Design notes learned the hard way:
 *  - Presence-only checks (`min(1)`), NOT format assumptions. A `.url()` rule rejected valid
 *    Postgres connection strings, and `min(16)` could reject a working token — both would brick
 *    a healthy deploy. We only care that the secret is *present*.
 *  - AI_GATEWAY_API_KEY is OPTIONAL: on Vercel the AI Gateway authenticates via OIDC
 *    (VERCEL_OIDC_TOKEN) with no explicit key, so requiring it would crash a correctly-configured
 *    deployment.
 *  - Validation is LAZY (first property access), not at import. `@t3-oss/env-core` validates when
 *    createEnv() runs, so calling it at module load would crash the whole function — including
 *    /health — if any var were missing. We defer it so a missing secret fails the specific request
 *    that needs it, loudly, while /health (which never reads env) keeps answering.
 */
type Env = {
  DATABASE_URL: string;
  SENDBLUE_API_KEY: string;
  SENDBLUE_API_SECRET: string;
  SENDBLUE_FROM_NUMBER: string;
  WEBHOOK_URL_TOKEN: string;
  CRON_SECRET: string;
  ALLOWED_PHONE: string;
  AI_GATEWAY_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  GROQ_API_KEY?: string;
};

let _env: Env | null = null;

function build(): Env {
  return createEnv({
    server: {
      DATABASE_URL: z.string().min(1),
      SENDBLUE_API_KEY: z.string().min(1),
      SENDBLUE_API_SECRET: z.string().min(1),
      SENDBLUE_FROM_NUMBER: z.string().min(1),
      WEBHOOK_URL_TOKEN: z.string().min(1),
      CRON_SECRET: z.string().min(1),
      ALLOWED_PHONE: z.string().min(1),
      AI_GATEWAY_API_KEY: z.string().min(1).optional(),
      // Optional $0 throttle-escape keys: direct provider calls that bypass the gateway's
      // account-wide free-tier rate limit. Each enables a fallback tier when present.
      GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
      GROQ_API_KEY: z.string().min(1).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.NODE_ENV === "test" || process.env.SKIP_ENV_VALIDATION === "1",
  }) as Env;
}

/** Lazy, memoized: validates on first property access, never at import. */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    if (!_env) _env = build();
    return _env[prop as keyof Env];
  },
});
