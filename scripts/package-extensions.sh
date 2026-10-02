#!/usr/bin/env bash
# Compatibility entry point. A release VSIX uses five previously built helpers.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/package-extensions.js --unified
