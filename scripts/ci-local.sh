#!/usr/bin/env bash
# Run the Rust CI gate locally. If TEST_DATABASE_URL is set, xtask also runs DB integration tests.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo xtask ci
