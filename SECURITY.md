# Security Policy

Andy handles financial data, personal messages, and provider secrets, so security reports are taken
seriously even though it's a single-user project.

## Supported versions

Only the latest `main` is supported. There are no released/tagged versions to back-port fixes to.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, report privately via GitHub:

- Go to the repository's **Security → Advisories → Report a vulnerability**
  ([Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability)), or
- Open a minimal private channel with the maintainer ([@ndycode](https://github.com/ndycode)).

Please include: a description, affected file(s)/path, reproduction steps or a proof of concept, and
the potential impact. You'll get an acknowledgement as soon as practical; since this is a personal
project maintained in spare time, response times are best-effort.

## Scope & non-secrets

- **Never include real secrets in a report or PR.** `.env`, `.env.local`, and any `.env.*` are
  git-ignored (only `.env.example` is committed) — keep it that way.
- Secret handling is centralized in `packages/shared/src/env.ts` (validated, lazy) and the inbound
  webhook is authenticated with a constant-time token compare; the cron route uses a bearer secret.
- In-scope examples: auth/allowlist bypass, secret leakage in logs/errors, injection, prompt-injection
  that drives unintended tool actions, or anything that corrupts the money ledger.
- Out of scope: issues that require the attacker to already control the host or the deploy secrets;
  rate-limit tuning preferences; and general "please deploy this for me" requests.
