#!/usr/bin/env node
const version = require('../packages/mcu-debug/package.json').version;
console.log(`MCU AI Debug ${version}: release through .github/workflows/package.yml.

Local validation: npm ci; npm test; npm run package:local
Unified release: GitHub Actions builds all five helpers and verifies one VSIX.
After reviewing and committing the changes, push tag v${version} to trigger release.
Workflow dispatch builds an artifact without publishing.
Open VSX publishes automatically with OVSX_PAT; upload the release VSIX to Marketplace manually.
This command does not tag, push, upload artifacts, or publish the upstream proxy.`);
