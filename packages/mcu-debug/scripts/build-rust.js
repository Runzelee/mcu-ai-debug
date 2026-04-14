#!/usr/bin/env node
// Cross-platform wrapper for build-binaries. Runs from monorepo root.
const { spawnSync } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'dev';
const root = path.resolve(__dirname, '../../..');
const isWin = process.platform === 'win32';

if (process.env.SKIP_RUST_BUILD === 'true' || process.env.SKIP_RUST_BUILD === '1') {
    console.log('SKIP_RUST_BUILD is set. Skipping Rust compilation.');
    process.exit(0);
}

let cmd, args;
if (isWin) {
    cmd = 'powershell.exe';
    const script = path.join(root, 'scripts', 'build-binaries.ps1');
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, mode];
} else {
    cmd = 'bash';
    const script = path.join(root, 'scripts', 'build-binaries.sh');
    args = [script, mode];
}

console.log(`Building Rust components (${mode}) via ${cmd}...`);
const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false });

if (result.error) {
    console.error('Failed to start build process:', result.error);
    process.exit(1);
}

process.exit(result.status ?? 1);
