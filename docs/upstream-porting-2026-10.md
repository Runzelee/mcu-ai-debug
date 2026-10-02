# Upstream porting and fork release audit — 2026-10-02

This is the current porting record for **MCU AI Debug 0.1.5**. It supersedes the feature-preservation and packaging guidance in the May, June, September and September 26 reports; those documents remain historical evidence.

## Baseline and method

- Fork workspace: `mcu-ai-debug`; branch at review: `codex/inherit-upstream-cli`.
- Committed fork baseline: `300420b`. The F5/CLI/Watch changes described here are in the working tree; this document does not imply they have been pushed or released.
- `git fetch upstream --prune` completed on 2026-10-02.
- Upstream default branch: [`main` at `1174ec5`](https://github.com/mcu-debug/mcu-debug/commit/1174ec52357de42176748d370c78af8117730c7f), already an ancestor of the fork. There are no newer default-branch commits to merge.
- Experimental branch inspected: [`rsp-mux` at `d21de32`](https://github.com/mcu-debug/mcu-debug/tree/d21de32), **28** commits beyond `main`, dated September 21 through October 1.
- Scope/dependency review used the commit list, changed-file inventory and branch diff. The four selected fix groups were inspected at code level and adapted manually. The experimental branch was not merged wholesale.
- Preserve the current CLI command mapping and session ownership. Do not replace F5 sharing with an independent Cockpit driver, or turn a CLI human interaction into MCP recording.

The earlier CLI/proxy deferrals are largely superseded by the September 26 integration. Rust `mdbg`, upstream CLI, remote proxy code and RTT/UART routing are now present. The remaining experimental RSP/Rust RTT migration is a separate architecture change.

## Fork behavior to preserve

| Area | Current fork contract |
| --- | --- |
| Identity | `Runzelee.mcu-ai-debug`, debugger type `mcu-debug`, public `mcu-ai-debug` CLI and compatibility `mcu-debug` wrapper. |
| F5 sharing | CLI and Cockpit dispatch to the selected IDE session and reuse its streams; detaching a client leaves F5 running. |
| Independent sessions | Retain independent Cockpit/CLI functionality as an explicit alternative, with session identities that stay fixed after attachment. |
| Multi-window management | Per-user session registry with unique IDs, workspace/configuration/window metadata; ambiguous selection requires an explicit session. |
| Manual | User Start approval → normal CLI GDB/RTT/UART → user Stop notification. No MCP, Live Watch subscription or automatic recording. |
| Agent reads | Prefer existing Live GDB `+p`/`+x` or RTT/UART; panel-cache reads do not add sampling. Add/remove watches only on explicit user request. |
| GDB Watch | Editor selection, batch add/remove, selected-leaf snapshots, CSV/JSONL recording and graphing. |
| UART UI | Add UART selects the host/device/baud rate, binds the selected F5 session or opens a standalone monitor. Clear Terminal clears only the selected tab and replay buffer. |
| JSON Watch | Passive RTT/UART JSON Lines / `name={...}` trees, typed snapshots/capture and mixed numeric graphs; session/transport/channel/port isolation; bounded buffers and UART reconnect handling. |
| UI | English text; one sidebar containing GDB above JSON Watch, both visible before debugging; old split-layout migration; one empty-state copy link; SVG graph controls. |
| Firmware/C++ | Structured RTT/UART telemetry; namespace globals and declaration deduplication; documented modm/lbuild/SCons configuration. |
| Legacy MCP | Deprecated, opt-in and disabled by default; no implicit workspace MCP generation. |
| Packaging | One fork-owned VSIX, including both CLI bundles, native runtime, Cockpit, Watch/graph resources, codicons, support scripts and firmware skill. |

## Adapted in this pass

| Upstream commit | Adaptation | Validation |
| --- | --- | --- |
| [`df8cb64`](https://github.com/mcu-debug/mcu-debug/commit/df8cb64) | Running-target `threads` requests return cached threads, or a fallback thread before the first stop, so VS Code can dispatch Pause. No running-target GDB thread query. | Adapter regression for pre-first-stop and cached multi-thread cases. |
| [`0ca3519`](https://github.com/mcu-debug/mcu-debug/commit/0ca3519) | Resolve references inside variable-map values before document substitution; nested builtins resolve in one pass and cycles retain authored values. Preserve the fork's workspaceRoot/cache-cloning/unresolved-command safeguards. | Upstream substitution regressions plus fork config-loader tests. |
| [`5b96e2b`](https://github.com/mcu-debug/mcu-debug/commit/5b96e2b) | Import `minimatch` through its named API; preserve exact/index selection, then allow one case-insensitive substring/glob match. Create logging transports before dev-mode setup. | Config selection regression, CLI build/smoke. |
| [`7de5791`](https://github.com/mcu-debug/mcu-debug/commit/7de5791), partial | Unique independent-CLI socket output-stream keys per connection; handle readline client errors without crashing the driver. Existing whole-record backlog replay is retained. No upstream batch scheduler/input-echo rewrite. | Real local-socket two-client output/disconnect regression, shared-F5 multi-window smoke. |

These are manual ports. The upstream hashes identify the source of a fix, not cherry-picked commits in this working tree.

## Remaining experimental commits

The table records scope decisions for every other commit in `1174ec5..d21de32`. “Deferred” is a dependency/validation decision, not a claim that the code is broken.

| Commit | Area and decision |
| --- | --- |
| `5208a11` | RSP mux transport/debug flags: deferred with the experimental transport architecture. |
| `77041e8` | Proxy for local debugging, security file, built-in RTT and Live Watch connection ordering: coupled runtime change; deferred. |
| `32b642f` | Security-file panic/error handling: depends on that new feature; deferred. |
| `5a43750` | Earlier Live GDB startup and launch-command docs: lifecycle requires target/server validation; deferred. |
| `45beacf` | Listener bind rejection: applies to the branch's changed remote listener implementation; deferred with proxy adaptation. |
| `2f5e963` | Stream close/cleanup ownership: broad CLI/proxy routing change; defer while preserving the fork's shared-client detach behavior. |
| `842c304` | Repository-wide formatting: not imported, to keep feature changes reviewable. |
| `cb66e5f` | Funnel client→server close semantics: deferred with the experimental proxy transport. |
| `80816d6`, `6341e1e` | RTT pipe decoder and throughput plumbing: optional future feature, not required for passive RTT Watch. |
| `62a3686`, `963fc82` | Rust RTT checkpoint/implementation and benchmarks: deferred as a complete architecture migration. |
| `a1248f1` | RSP RLE/reply ownership: belongs to the deferred mux. |
| `f46bc92` | Agent-side RTT avoiding another GDB: depends on the Rust RTT path. Current F5 attachment already reuses the existing streams; it may still use the existing Live GDB for explicit reads. |
| `e51b8e5`, `4306dae`, `7532e23`, `889748c` | Benchmark counting/corrections: reviewed as experimental evidence; no throughput claims transferred to this fork. |
| `502f335` | CLI batch scheduler and command surface: defer until adapted against session selection, manual gating and upstream-compatible command mapping. |
| `19b3e6d` | Process/session identity reporting: depends on the branch's new identity fields; deferred. |
| `42eea60` | Daemon reuse pinned to commit: deferred with proxy singleton/runtime identity changes. |
| `4b83d7e` | Upstream agent rules: not imported as fork product behavior. |
| `fd81766`, `d21de32` | Rust RTT drain limits, control-block retries, clear-search and idle backoff: depend on the deferred Rust RTT backend and need hardware tests. |

The inherited Live GDB lifecycle fixes from older reports are already part of the integrated upstream history. Future review should compare actual code rather than re-importing them by commit title.

## Version and release policy

The local development sequence `0.1.18` through `0.1.27` is consolidated into the requested fork release **0.1.5**, following the earlier fork release `0.1.4`. This is a deliberate reset of local development numbering, not a semantic claim that 0.1.5 sorts above 0.1.27. Installed development versions may require an explicit VSIX downgrade.

Only `VERSION` in `scripts/sync-versions.js` is edited. `npm run version:sync` aligns the fork extension, companion development package and Rust crate; lockfiles follow. The fork's tag-based release workflow determines publication, and does not inherit upstream's odd-minor prerelease heuristic.

The proxy code remains available for development, but the fork does not publish the upstream-owned `mcu-debug.mcu-debug-proxy` listing. The proxy package/runtime version being aligned does not imply a separately released fork proxy artifact.

## Packaging audit and changes

| Finding | Resolution |
| --- | --- |
| Root `package` required macOS, packaged two extensions and pushed an artifacts repository. | `package`/`package:local` now build one current-platform fork VSIX without network publication. `package:unified` uses five prebuilt helpers and creates one release VSIX. |
| Manual local packaging could omit the platform helper because dev builds produce unqualified `bin/mdbg`. | Local entry point rebuilds and copies the helper into the correct platform directory before platform-scoped VSIX packaging. |
| Clean prepublish did not copy codicons. | `build-all` copies codicon CSS/font and package verification requires them. |
| Cockpit build ran an extra `npm install` after root dependency installation. | Use the existing npm workspace build under the root lockfile. |
| CI silently tolerated missing downloaded artifacts. | Remove `cp ... || true`; artifact upload fails if files are absent. |
| Artifact transfers discard Unix executable bits. | Restore permissions after consolidation and check them inside the final ZIP. [GitHub artifact documentation](https://github.com/actions/upload-artifact#permission-loss). |
| CI only checked five binary filenames. | Shared validator checks manifest identity/version, always-visible Watch views, MCP default, helper permissions/header/count and every required CLI/Cockpit/Watch/support/font/skill runtime file. |
| Fork unit-test glob could be passed literally by the shell. | Supported top-level test entry point; release gate runs unit tests and shared/frontend/proxy type checks. |
| Two Rust tests expected an untracked local ELF/ARM objdump setup. | Mark only those fixture tests explicitly ignored; default suite is runnable on a clean CI checkout. Their opt-in invocation is documented. |
| Windows PowerShell helper script named the deleted `mcu-debug-helper` crate. | Delegate to the current native Node/Rust wrapper for `packages/mdbg`. |
| Old local release script used upstream asset names/publisher/token conventions. | Redirect release/publish commands to the fork's Actions instructions; they perform no tagging, pushing or publication. |
| CI used `npm install` and mixed build/publication Node versions. | Use `npm ci`, Node 24 and checkout/setup-node v6 throughout the package workflow. |
| Fork has no GitHub Pages configuration, but inherited docs workflow tried to deploy. | Keep the documentation build and artifact; remove the Pages deployment and write permissions. |
| Marketplace publication is handled manually. | Remove its publishing job; Open VSX still publishes the exact verified release artifact. |
| GitHub release had no fork-specific notes. | Generate notes from the current changelog entry and exclude inherited/unpublished history. |

The release workflow builds the five existing supported targets: Darwin ARM64/x64, Linux ARM64/x64 and Windows x64. A tagged build checks tag/version equality and uploads/publishes the exact verified unified VSIX. Workflow dispatch packages without publication. `OVSX_PAT` is required for automatic Open VSX publication. Marketplace publication is manual; the workflow contains no Marketplace publishing job.

## Validation and limits

Final validation results for this working-tree release are recorded below. Existing hardware observations are not counted as evidence that the experimental RSP/Rust RTT branch works.

- `npm run test:unit --workspace=packages/mcu-debug`: **130 passed**, including UART CLI routing, UTF-8 fragmentation, slow JSON lines, reconnects, transport/host isolation, Windows COM paths, explicit UART opening and mixed recording. `npm run check:shared-package` and full extension TypeScript check passed.
- `npm run test:rust`: **342 passed, 2 explicitly ignored fixture tests**. Clippy and Rust formatting check passed.
- `npm run package:local`: passed; produced the **Linux x64 0.1.5 VSIX**. Native helper reports 0.1.5 and all required packaged runtime files passed validation. Negative package fixtures were rejected for missing AI CLI/font, missing executable permissions and wrong ELF architecture.
- Final packaged 0.1.5 two-window mock-DAP/RTT/UART-bridge smoke passed, including session selection, shared GDB/RTT/UART routing, UART writes gated by manual Start/Stop, panel mutation authorization, capture and detach behavior. Real isolated VS Code UI passed for before-debug sidebar order, empty-state copying, mixed RTT/UART graphs, graph controls, actual Clear Terminal clicks and light/dark/narrow layouts.
- Packaged helper discovered modm namespace globals (`app::pb8_debug`, `SystemCoreClock`) and `_SEGGER_RTT`. The installed 0.1.5 activation/wrapper smoke passed.
- All four workflows passed **actionlint 1.7.12**; YAML parsing, `npm ci --ignore-scripts --dry-run`, local README link checks, version synchronization and `git diff --check` passed.
- Five-platform GitHub Actions execution, Marketplace/Open VSX publication and native macOS/Windows execution have not been run in this local review.
- UART validation used the serial TCP bridge, not a physical UART device. New pause/substitution/socket changes have no MCU hardware run in this pass; mock and pure-code checks are identified separately.

Next upstream review should start from default `main` at `1174ec5` and experimental `rsp-mux` at `d21de32`. Prioritize complete session/lifecycle validation before importing the experimental mux, Rust RTT or batch scheduler.
