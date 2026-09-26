# Upstream CLI integration — 2026-09-26

This review supersedes the CLI deferral in [the 2026-09-12 review](./upstream-porting-2026-09.md). The fork now adopts the upstream CLI, AI Cockpit, session socket, RTT/UART routing, remote proxy support, and the `mdbg` Rust runtime from upstream `1174ec5`. The fork baseline before integration was `97b6d2b`.

The upstream runtime and proxy are tightly coupled to the CLI. They were integrated as one merge instead of copying the CLI TypeScript files alone. The fork retains its `Runzelee.mcu-ai-debug` identity, dedicated Live Watch view, editor expression command, batch editing, snapshot export, local recording, and graphing. The companion proxy remains the upstream `mcu-debug.mcu-debug-proxy` extension; its version and the bundled `mdbg` version are aligned at `0.1.18`.

The fork's Live Watch MCP bridge remains available for existing clients but is deprecated. `mcu-ai-debug.enableMcp` defaults to `false`; startup does not bind its TCP port or generate workspace MCP files. Users who enable it can explicitly run the deprecated configuration command. Existing workspace MCP files are left to their owners.

## Validation

- `npm run compile` passed with Node.js 24: shared package, Rust helper build, CLI, VS Code extension, companion proxy, and Cockpit.
- `node --import tsx --test packages/mcu-debug/src/test/*.test.ts` passed: 84 tests.
- Rust library tests passed for 342 of 344 cases. The two remaining upstream disassembly tests require an untracked `mylfs/proj_cm4.elf` sample; they fail without that file, and the other 342 pass when those two are filtered out.
- `mdbg --help`, `mdbg --version`, and the bundled CLI `--version` entry points ran successfully without hardware.
- A local VSIX packaging smoke test passed and included the CLI, adapter, extension, and AI skill. It had no cross-platform `mdbg` binaries, so it is not a release artifact.
- The fork release workflow was updated for Node.js 24 and `mdbg` binary names. A full cross-platform VSIX release build was not run locally.

A real MCU session is still needed to check probe startup, RTT input/output, Live Watch while running, disconnect cleanup, and remote proxy operation on each target topology. No deployment or registry publication was performed by this integration.
