# Compatibility entry point; uses the current packages/mdbg runtime.
$ErrorActionPreference = "Stop"
$Mode = if ($args.Count -gt 0) { $args[0] } else { "dev" }
& node (Join-Path $PSScriptRoot "../packages/mcu-debug/scripts/build-rust.js") $Mode
exit $LASTEXITCODE
