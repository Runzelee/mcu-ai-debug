#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/packages/mcu-debug/bin"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Helper binary source directory does not exist: $SRC_DIR"
  echo "Run ./scripts/build-binaries.sh [dev|prod] first."
  exit 1
fi

echo "Helper binaries are already in place:"
echo "  source: $SRC_DIR"
