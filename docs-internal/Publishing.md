# Publishing MCU AI Debug

The fork releases one `Runzelee.mcu-ai-debug` extension through `.github/workflows/package.yml`. Open VSX publication is automatic; VS Code Marketplace publication is manual. The upstream proxy listing is not published by this fork.

## Prepare a release

1. Set `VERSION` in `scripts/sync-versions.js`, run `npm run version:sync`, and align the lockfiles.
2. Update the current release entry in `packages/mcu-debug/CHANGELOG.md`. `node scripts/release-notes.js` prints that entry without inherited or unpublished development history.
3. Run `npm test`, `npm run test:rust`, `npm run lint:rust`, `npm run typecheck --workspace=cockpit-webview`, and `npm run check:shared-package`.
4. Run `npm run package:local` to verify the current-platform VSIX. This rebuilds the native helper and validates the packaged CLI, Watch, Cockpit, codicons, support scripts and firmware skill.
5. Commit and push the final source to `main`, then push an annotated `v<version>` tag pointing to that commit. Check for an inherited upstream tag with the same name before creating a fork tag; keep its local provenance if it must be renamed. Never overwrite an existing fork release tag.

`npm run package` is an alias for `package:local`. The old `publish`, `publish:dryrun` and `release` commands only print the fork's release instructions; they do not commit, tag, push or publish.

## GitHub Actions

A matching version tag runs source verification, builds five native helpers (Darwin ARM64/x64, Linux ARM64/x64 and Windows x64), and packages one unified `dist/mcu-ai-debug-<version>.vsix`. Downloaded helper executable permissions are restored and the final archive is checked before release.

The workflow creates a GitHub Release with the current changelog entry and that exact VSIX. Open VSX then publishes the same artifact using the repository's `OVSX_PAT` secret; a missing token fails publication. Tokens remain in GitHub Actions secrets and are never committed.

Workflow dispatch builds and uploads an artifact without creating a release or publishing to Open VSX. Use it when a build-only run is needed.

## Marketplace upload

Download the unified VSIX from the GitHub Release and upload it through the VS Code Marketplace publisher portal. The workflow has no Marketplace publishing job and does not use `VSCE_PAT`.

The fork does not inherit upstream's odd-minor prerelease convention. Release tags must match the extension version exactly. See the [current porting and packaging audit](../docs/upstream-porting-2026-10.md) for architecture decisions and validation limits.

## Other checks

Rust CI runs the tests, clippy and RustSec audit on main and pull requests. Shared Package Check validates generated/shared/frontend/proxy boundaries. Build Documentation compiles changed docs or bundled skill content and uploads the site artifact; the fork has no GitHub Pages deployment configured.
