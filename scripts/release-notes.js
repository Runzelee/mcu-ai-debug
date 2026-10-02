#!/usr/bin/env node
// Print the current fork release entry, excluding inherited and unpublished history.
const fs = require('node:fs');
const path = require('node:path');
const version = require('../packages/mcu-debug/package.json').version;
const lines = fs.readFileSync(path.join(__dirname, '../packages/mcu-debug/CHANGELOG.md'), 'utf8').split(/\r?\n/);
const heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`);
const start = lines.findIndex(line => heading.test(line));
if (start < 0) throw new Error(`Missing changelog entry for ${version}`);
let end = start + 1;
while (end < lines.length && !/^## |^### Historical\b/.test(lines[end])) end++;
const notes = lines.slice(start + 1, end).join('\n').trim();
if (!notes) throw new Error(`Empty changelog entry for ${version}`);
process.stdout.write(`# MCU AI Debug v${version}\n\n${notes}\n`);
