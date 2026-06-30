# security

andy handles money data, personal messages, phone numbers, and provider secrets. security matters even though this is a single-user project.

## supported versions

only latest `main` is supported. there are no release branches or backports.

## report privately

please do not open a public issue for a vulnerability.

use GitHub's private vulnerability reporting:

- open **Security -> Advisories -> Report a vulnerability**
- or contact [@ndycode](https://github.com/ndycode) through a private channel

include what happened, affected paths, reproduction steps or proof of concept, and the impact. response is best-effort because this is a personal project, but real security reports get treated seriously.

## keep secrets out

never paste real secrets into issues, PRs, screenshots, or reports. `.env`, `.env.local`, and `.env.*` stay ignored. only `.env.example` belongs in git.

secret handling lives in `crates/shared/src/env.rs`. inbound Sendblue webhooks use a self-minted URL token with constant-time compare. cron uses `CRON_SECRET` as a bearer token.

## webhook token hashing

the webhook token may be stored as a SHA-256 hash via `WEBHOOK_URL_TOKEN_SHA256` instead of the plaintext `WEBHOOK_URL_TOKEN`. when the hash is set, the webhook compares `sha256(?t=...)` against it with a constant-time compare, so the raw token never needs to live in env. a malformed hash is rejected at startup rather than silently disabling auth. query parsing percent-decodes the value and rejects repeated `t=` parameters.

## provider error redaction

provider error bodies are never persisted or sent to the user. Sendblue failures are reduced to a coarse class (`timeout`, `auth`, `rate_limited`, `server_error`, `client_error`, `unknown`) plus status code; only that summary is logged and stored in `outbound_messages.last_error`. OpenRouter error bodies are reduced to a short, secret-stripped excerpt, and user-facing failure copy is canned (it never includes the raw body). outbound sends have a finite retry budget and dead-letter to `failed` rather than retrying forever.

## prompt-injection mitigation

the model is not the final authority on dangerous ledger actions. a deterministic policy (`crates/ai/src/policy.rs`) runs between model output and the database flush: destructive writes, high-value amounts, oversized turns, and mixed destructive+constructive turns require explicit user confirmation, and a one-off transaction smuggled into durable memory is rejected outright. read-only tools cannot emit write intents. every committed transaction records the source message id for audit.

## in scope

- auth or allowlist bypass
- provider secret leaks in logs, errors, or build output
- injection that changes stored financial data
- prompt injection that drives unintended tool actions
- anything that corrupts the ledger or makes the numbers lie

## out of scope

- attacks that already require host or deploy-secret control
- rate-limit preference tweaks
- "please deploy this for me" requests
- generic dependency reports with no reachable exploit path
