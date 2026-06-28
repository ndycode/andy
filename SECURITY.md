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

secret handling lives in `packages/shared/src/env.ts`. inbound Sendblue webhooks use a self-minted URL token with constant-time compare. cron uses `CRON_SECRET` as a bearer token.

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
