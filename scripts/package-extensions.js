#!/usr/bin/env node
// Package the fork's one extension. Publishing belongs to GitHub Actions.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyVsix, targets, binaryName } = require('./verify-vsix');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'packages/mcu-debug');
const unified = process.argv.includes('--unified');
const hostTarget = `${process.platform}-${process.arch}`;
function run(args, cwd = root, env = {}) {
    const result = spawnSync(process.execPath, args, {cwd, env: {...process.env, ...env}, stdio: 'inherit'});
    if (result.error || result.status !== 0) throw result.error || new Error(`${args.join(' ')} failed (${result.status})`);
}
async function main() {
    if (process.argv.slice(2).some(arg => !['--local', '--unified'].includes(arg))) throw new Error('Usage: npm run package:local | npm run package:unified');
    run(['scripts/sync-versions.js', '--check']);
    if (!unified) {
        if (!targets.includes(hostTarget)) throw new Error(`Unsupported local target: ${hostTarget}`);
        // Do not inherit SKIP_RUST_BUILD: a local package must have a freshly built helper.
        run(['packages/mcu-debug/scripts/build-rust.js', 'dev'], root, {SKIP_RUST_BUILD: ''});
        const dir = path.join(extension, 'bin', hostTarget), name = binaryName(hostTarget);
        fs.mkdirSync(dir, {recursive: true});
        const temp = path.join(dir, `.${name}.tmp.${process.pid}`);
        fs.copyFileSync(path.join(extension, 'bin', name), temp);
        if (process.platform !== 'win32') fs.chmodSync(temp, 0o755);
        if (process.platform === 'linux') {
            const strip = spawnSync('strip', [temp], {stdio: 'inherit'});
            if (strip.error?.code !== 'ENOENT' && strip.status !== 0) throw strip.error || new Error('strip failed');
        }
        fs.renameSync(temp, path.join(dir, name));
    }
    for (const target of unified ? targets : [hostTarget]) {
        const binary = path.join(extension, 'bin', target, binaryName(target));
        if (!fs.existsSync(binary) || fs.statSync(binary).size < 1024) throw new Error(`Missing helper: ${binary}. Build all five targets in GitHub Actions before packaging a unified VSIX.`);
        if (!target.startsWith('win32-')) fs.chmodSync(binary, 0o755);
    }
    const version = require('../packages/mcu-debug/package.json').version;
    if (targets.includes(hostTarget)) {
        const helper = path.join(extension, 'bin', hostTarget, binaryName(hostTarget));
        const result = spawnSync(helper, ['--version'], {encoding: 'utf8'});
        if (result.status !== 0 || !new RegExp(`\\b${version.replace(/\./g, '\\.')}\\b`).test(result.stdout || '')) throw new Error('Host helper does not report the expected version: ' + version);
    }
    const output = path.join(root, 'dist', `mcu-ai-debug-${version}${unified ? '' : '-' + hostTarget}.vsix`);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    const vsce = require.resolve('@vscode/vsce/vsce');
    run([vsce, 'package', '--no-dependencies', ...(unified ? [] : ['--target', hostTarget, '--ignore-other-target-folders']), '--out', output], extension, {SKIP_RUST_BUILD: 'true'});
    await verifyVsix(output, unified ? 'unified' : hostTarget);
}
main().catch(error => {console.error(error.message);process.exitCode = 1;});
