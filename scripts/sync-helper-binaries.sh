#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/packages/mcu-debug/bin"
PROXY_DIR="$ROOT_DIR/packages/mcu-debug-proxy/bin"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Helper binary source directory does not exist: $SRC_DIR"
  echo "Run ./scripts/build-binaries.sh [dev|prod] first."
  exit 1
fi

[[ -n "${PROXY_DIR:-}" && "$PROXY_DIR" != "/" ]] || {
  echo "Refusing to clear PROXY_DIR='$PROXY_DIR'"
  exit 1
}

mkdir -p "$PROXY_DIR"

# Keep proxy package binary folder as an exact mirror of the source of truth.
find "$PROXY_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -R "$SRC_DIR"/. "$PROXY_DIR"/

echo "Synchronized helper binaries:"
echo "  source: $SRC_DIR"
echo "  target: $PROXY_DIR"
