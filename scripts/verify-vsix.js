#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const binaryName = target => target.startsWith('win32-') ? 'mdbg.exe' : 'mdbg';
const requiredFiles = [
    'package.json', 'README.md', 'CHANGELOG.md',
    'dist/extension.js', 'dist/adapter.js', 'dist/mcu-debug-cli.js', 'dist/mcu-ai-debug-cli.js',
    'resources/cockpit/index.html', 'resources/cockpit/cockpit.js', 'resources/cockpit/cockpit.css',
    'resources/webview-tree.js', 'resources/webview-tree.css',
    'resources/live-watch-graph.html', 'resources/live-watch-graph.js',
    'resources/codicons/codicon.css', 'resources/codicons/codicon.ttf',
    'support/gdbsupport.init', 'support/gdb-swo.init', 'support/openocd-helpers.tcl',
    'support/install-cli.js', 'support/skills/mcu-ai-debug-fw/SKILL.md',
];
async function readArchive(file) {
    return new Promise((resolve, reject) => {
        const entries = new Map();
        yauzl.open(file, { lazyEntries: true }, (error, zip) => {
            if (error) return reject(error);
            zip.on('error', reject);
            zip.on('end', () => resolve(entries));
            zip.on('entry', entry => {
                if (entry.fileName.endsWith('/')) return zip.readEntry();
                assert(!entries.has(entry.fileName), `Duplicate ZIP entry: ${entry.fileName}`);
                zip.openReadStream(entry, (error, stream) => {
                    if (error) return reject(error);
                    const chunks = [];
                    stream.on('error', reject);
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.on('end', () => {entries.set(entry.fileName, {data: Buffer.concat(chunks), mode: entry.externalFileAttributes >>> 16});zip.readEntry();});
                });
            });
            zip.readEntry();
        });
    });
}
async function verifyVsix(file, target = 'unified') {
    assert(target === 'unified' || targets.includes(target), `Unsupported target: ${target}`);
    const entries = await readArchive(file);
    const get = name => entries.get('extension/' + name) ?? entries.get('extension/' + name.toLowerCase());
    for (const name of requiredFiles) assert(get(name)?.data.length, `Missing or empty runtime file: ${name}`);
    const packaged = JSON.parse(get('package.json').data.toString());
    const source = require('../packages/mcu-debug/package.json');
    assert.equal(packaged.name, 'mcu-ai-debug');
    assert.equal(packaged.publisher, 'Runzelee');
    assert.equal(packaged.version, source.version);
    const watches = packaged.contributes.views['mcu-ai-debug'];
    assert.deepEqual(watches.map(view => view.id), ['mcu-debug.liveWatch', 'mcu-ai-debug.rttLiveWatch']);
    assert.deepEqual(watches.map(view => view.name), ['GDB Live Watch', 'JSON Live Watch']);
    assert(watches.every(view => !view.when), 'Both watches must be available before debugging');
    const sections = Array.isArray(packaged.contributes.configuration) ? packaged.contributes.configuration : [packaged.contributes.configuration];
    const settings = Object.assign({}, ...sections.map(section => section.properties));
    assert.equal(settings['mcu-ai-debug.enableMcp'].default, false);
    assert(get('resources/webview-tree.js').data.toString().includes('Click to copy firmware prompt.'));
    const wanted = target === 'unified' ? targets : [target];
    for (const platform of wanted) {
        const name = `bin/${platform}/${binaryName(platform)}`, entry = get(name);
        assert(entry?.data.length > 1024, `Missing or empty native helper: ${name}`);
        if (!platform.startsWith('win32-')) assert(entry.mode & 0o111, `Native helper lost executable permissions: ${name}`);
        if (platform.startsWith('linux-')) {
            assert.equal(entry.data.subarray(0, 4).toString(), '\x7fELF', `Not an ELF: ${name}`);
            assert.equal(entry.data.readUInt16LE(18), platform.endsWith('arm64') ? 183 : 62, `Wrong ELF architecture: ${name}`);
        }
        if (platform.startsWith('win32-')) {
            assert.equal(entry.data.subarray(0, 2).toString(), 'MZ', `Not a Windows executable: ${name}`);
            const pe = entry.data.readUInt32LE(60);
            assert.equal(entry.data.subarray(pe, pe + 4).toString(), 'PE\0\0', `Invalid PE header: ${name}`);
            assert.equal(entry.data.readUInt16LE(pe + 4), 0x8664, `Wrong PE architecture: ${name}`);
        }
        if (platform.startsWith('darwin-')) {
            assert.equal(entry.data.readUInt32LE(0), 0xfeedfacf, `Not a Mach-O executable: ${name}`);
            assert.equal(entry.data.readUInt32LE(4), platform.endsWith('arm64') ? 0x0100000c : 0x01000007, `Wrong Mach-O architecture: ${name}`);
        }
    }
    const binaries = [...entries.keys()].filter(name => /^extension\/bin\/[^/]+\/mdbg(?:\.exe)?$/.test(name));
    assert.equal(binaries.length, wanted.length, 'Unexpected platform helpers in VSIX');
    assert(!entries.has('extension/bin/mdbg') && !entries.has('extension/bin/mdbg.exe'), 'Unqualified development helper must not ship');
    console.log(`Verified ${path.basename(file)}: ${packaged.version}, ${wanted.length} helper(s), CLI/Watch/Cockpit/skill runtime files complete.`);
}
module.exports = { verifyVsix, targets, binaryName };
if (require.main === module) verifyVsix(process.argv[2], process.argv[3] || 'unified').catch(error => {console.error(error.message);process.exitCode = 1;});
