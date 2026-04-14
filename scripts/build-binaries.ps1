# Build script for producing Rust executables for Windows.
# Usage: .\scripts\build-binaries.ps1 [dev|prod|prod-local]

$Mode = if ($args.Count -gt 0) { $args[0] } else { "dev" }

$RootDir = Get-Location
$RustDir = Join-Path $RootDir "packages/mcu-debug-helper"
$BinDir = Join-Path $RootDir "packages/mcu-debug/bin"
$BinName = "mcu-debug-helper.exe"
$Prettier = Join-Path $RootDir "node_modules/.bin/prettier.cmd"
$SharedDir = Join-Path $RootDir "packages/shared"

if (!(Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}

function Format-TS-Exports {
    if (Test-Path $Prettier) {
        Write-Host "Formatting generated TypeScript exports..."
        # Ignore errors if prettier fails
        try {
            & $Prettier --write --print-width 120 `
                (Join-Path $SharedDir "dasm-helper") `
                (Join-Path $SharedDir "proxy-protocol") `
                | Out-Null
        } catch {}
    } else {
        Write-Warning "Prettier not found at $Prettier, skipping format"
    }
}

function Get-Host-Platform {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "ARM64") { return "win32-arm64" }
    return "win32-x64"
}

function Get-Native-Rust-Target {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "ARM64") { return "aarch64-pc-windows-msvc" }
    # Prefer GNU target on Windows if MSVC is not available
    return "x86_64-pc-windows-gnu"
}

function Copy-Artifact {
    param($src, $destDir, $destName)
    if (!(Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir | Out-Null
    }
    if (!(Test-Path $src)) {
        Write-Warning "Artifact not found: $src"
        return $false
    }
    Copy-Item $src (Join-Path $destDir $destName) -Force
    Write-Host "Wrote: $(Join-Path $destDir $destName)"
    return $true
}

Set-Location $RustDir

# Common steps: Generate TS exports
Write-Host "Generating TypeScript exports..."
& cargo test --lib helper_requests::tests::ensure_ts_exports --quiet 2>$null
# proxy_server might have been removed or renamed in the cleanup, ignore if fails
& cargo test --lib proxy_server::tests::ensure_ts_exports --quiet 2>$null
Format-TS-Exports

$Target = Get-Native-Rust-Target
$HostPlatform = Get-Host-Platform

if ($Mode -eq "dev") {
    Write-Host "Dev build: building for host platform (debug)"
    & cargo build --bin mcu-debug-helper --target $Target
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Cargo build failed for $Target"
        exit 1
    }
    $DbgPath = "target/$Target/debug/$BinName"
    
    Copy-Artifact $DbgPath $BinDir $BinName
    Write-Host "Dev build complete."
    exit 0
}

if ($Mode -eq "prod-local") {
    Write-Host "Production (Local) build: release build for host platform only"
    & cargo build --release --bin mcu-debug-helper --target $Target
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Cargo build failed for $Target"
        exit 1
    }
    $RelPath = "target/$Target/release/$BinName"
    
    Copy-Artifact $RelPath (Join-Path $BinDir $HostPlatform) $BinName
    Write-Host "Prod-local build complete."
    exit 0
}

if ($Mode -eq "prod") {
    Write-Host "Production build: release builds for multiple targets"
    
    # On Windows, we primarily build the Windows target. 
    # Multi-platform cross-compilation is usually handled in CI (macOS/Linux).
    $Targets = @(
        @{ Platform = "win32-x64"; Triple = "x86_64-pc-windows-gnu" }
    )

    foreach ($Entry in $Targets) {
        $T = $Entry.Triple
        $P = $Entry.Platform
        Write-Host "`nBuilding target: $T (platform: $P)"
        
        & cargo build --release --bin mcu-debug-helper --target $T
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Cargo build failed for $T"
            exit 1
        }
        
        $Artifact = "target/$T/release/$BinName"
        Copy-Artifact $Artifact (Join-Path $BinDir $P) $BinName
    }

    Write-Host "Production build done."
    exit 0
}

Write-Error "Unknown mode: $Mode"
exit 2
