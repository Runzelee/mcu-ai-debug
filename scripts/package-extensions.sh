#!/bin/bash
# scripts/package-extensions.sh

set -e
mkdir -p dist
rm -f dist/*.vsix

echo "==> Build mode preflight..."
if command -v cross >/dev/null 2>&1; then
	if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
		echo "Mode: cross+container (cross builds can run in containers)"
	else
		echo "Mode: cross installed, but no Docker/Podman detected"
		echo "      build-binaries.sh will use cargo fallback for non-Darwin targets"
	fi
else
	echo "Mode: cargo-only (cross not installed)"
fi
echo ""

echo "==> Syncing helper binaries..."
bash ./scripts/sync-helper-binaries.sh

echo "==> Packaging mcu-debug..."
cd packages/mcu-debug
# Force npx vsce for better compatibility on Windows/WSL
npx vsce package --no-dependencies --out ../../dist/

echo ""
echo "✓ Extension packaged in ./dist/"
ls -lh ../../dist/*.vsix
