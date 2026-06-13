#!/usr/bin/env bash
# Run the FULL CI gate locally, mirroring .github/workflows/ci.yml exactly — including the
# Postgres-backed DB-layer integration tests. Useful because GitHub Actions may be unavailable
# (e.g. disabled for the account), so this is the dependable green-checkmark you can run on demand.
#
# Usage:  bun run ci:local        (or ./scripts/ci-local.sh)
# Requires: docker (for the ephemeral Postgres). Everything is torn down on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_NAME="andy-ci-local"
PG_PORT="55434" # off the default to avoid clashing with a local/dev Postgres
TEST_URL="postgres://postgres:postgres@localhost:${PG_PORT}/andy_test"

cleanup() { docker rm -f "$PG_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▸ typecheck";            bun run typecheck
echo "▸ lint";                 bun run lint
echo "▸ test (unit)";          bun test
echo "▸ build (vercel bundle)"; bun run build

echo "▸ starting ephemeral Postgres for integration tests…"
cleanup
docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=andy_test \
  -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
# Wait for readiness (max ~60s).
for _ in $(seq 1 60); do
  docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "▸ integration tests (DB layer vs real Postgres)";
TEST_DATABASE_URL="$TEST_URL" bun test packages/db/src/queries.integration.test.ts

echo ""
echo "✅ Full CI gate passed locally (typecheck · lint · unit · build · DB integration)."
