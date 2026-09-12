# Upstream Porting Status - 2026-09-12

This document continues `docs/upstream-porting-2026-06.md` and records the
third selective upstream review from `mcu-debug/mcu-debug` into this fork.

## Baseline

- Review date: 2026-09-12
- Next scheduled upstream review: 2026-10-12
- Local fork head before this pass: `777bb52`
- Upstream remote: `upstream`
- Previously reviewed upstream head: `3fa6956`
- Current upstream head reviewed: `794398f`
- Merge base with upstream: `2e6992a`
- New commits reviewed in this pass: 165
- Total divergence at review time: 18 local-only commits and 289 upstream-only commits

The review covered every commit in `3fa6956..794398f`. The range changes 210
files with 21,402 insertions and 6,178 deletions. A direct merge is still
unsafe: most changes extend the upstream CLI/TUI, proxy singleton, remote host,
serial transport, documentation site, release, and renamed `mdbg` helper
architecture that this fork intentionally has not adopted.

The working tree was clean before this review.

## Fork Features To Preserve

The previous preservation list remains in force:

- MCP server and bridge behavior
- Live Watch snapshot, recording, graphing, local struct selection, and the
  fork-owned webview tree
- MCU-AI-Debug branding, command IDs, publisher metadata, and settings
- Fork documentation in `README.md` and `docs/mcu-debug-mcp.md`

## Ported In This Pass

- `6fecc9a` partial: removed the accidental leading space from probe-rs's
  `--non-interactive` argument. The commit's detach/lifecycle and managed-tab
  changes were not imported because this fork has a different termination
  policy and does not contain the later upstream managed-tab implementation.

## Reviewed And Deferred

### CLI, TUI, Proxy, Serial, and Remote Runtime

The July-August work from `dabe59e` through `fb1bca9`, plus the September
release work from `b0112a2` through `a35fee7`, forms a connected runtime and
packaging migration. It includes proxy daemonization and singleton ownership,
multi-listener serial routing, WSL/SSH policy, new port allocation, the CLI
driver, background-session behavior, and proxy-extension activation policy.
These changes cannot be safely reduced to isolated patches without importing
the product architecture that this fork previously rejected.

### Live GDB And Automatic Live Watch Lifecycle

- `383cf2b`, `08e0c7f`, `43b6b7c`, and `470c4b4`

These commits add client unregistering, notification modes, lazy connection
startup, connection failure reasons, and automatic Live Watch activation. They
are useful, but they change the adapter/frontend registration protocol as one
unit. They need a dedicated adaptation that keeps this fork's MCP listeners,
recording lifecycle, and single-session behavior, followed by hardware tests
for running-target reads and disconnect cleanup.

### Debugger And Server Lifecycle Fixes

- Deferred portions of `6fecc9a`
- `628ae75`, `9fdccb5`, `01d6bbc`, `4b8bcd4`, `5a2830c`, `d125dd3`, and
  `1cddd4d`

The early architecture query, port allocator, proxy exit handling, and memory
error changes depend on surrounding upstream APIs. The server-output issue in
`9fdccb5` does not apply directly: this fork already matches against an
accumulated split-chunk buffer instead of the upstream line parser. The memory
notification changes in `1cddd4d` remain a reasonable standalone candidate
after response-destination tests are added.

### Documentation, Repository Policy, And Release Automation

The issue forms, Docusaurus updates, AI skill material, changelogs, marketplace
release scripts, version bumps, generated assets, and upstream `AGENTS.md`/
Claude settings describe upstream's CLI/proxy product and release process.
They were reviewed but are not portable fork functionality.

## Validation

- `npm run compile`: passed, including shared TypeScript/esbuild, Rust helper
  tests/build, generated manifest, strict TypeScript checking, and extension
  bundling.
- Direct Node test invocation: passed (14 tests), including three focused batch
  expression parser tests and the existing sync-file utility tests.
- `node --check packages/mcu-debug/resources/webview-tree.js`: passed.
- Local browser Webview harness: confirmed multiline candidates appear as
  individually checked items, unchecked candidates are excluded from addition,
  existing watches can be selected together, and the bulk-removal result clears
  the selection.
- `git diff --check`: passed.

No MCU hardware debug session was available, so probe-rs launch and the
deferred Live GDB lifecycle remain unverified on a device. The browser harness
used the real Webview JavaScript and CSS with a mock extension-message backend;
it does not replace a VS Code Extension Development Host smoke test.

## Next Pass

1. Start the next review from `794398f`.
2. Adapt `383cf2b..470c4b4` only as one Live GDB lifecycle change, with MCP and
   recording regression coverage plus on-device running/disconnect tests.
3. Add response-destination tests before considering the non-popup memory
   errors from `1cddd4d`.
4. Keep the CLI/TUI/proxy singleton/serial stack and upstream release pipeline
   out until their product-level adoption is explicitly approved.
