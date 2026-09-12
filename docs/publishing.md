# Automated Extension Publishing

`.github/workflows/package.yml` builds the native helper on GitHub-hosted Linux
and macOS runners, packages one unified VSIX, creates the GitHub Release, and
publishes that exact VSIX to the configured extension registries.

Publishing runs only for a pushed `v*` tag. A manual `workflow_dispatch` builds
the VSIX artifact but does not publish it.

## One-time registry setup

Add these repository Actions secrets under **Settings → Secrets and variables →
Actions**:

| Secret     | Used for                                                      |
| ---------- | ------------------------------------------------------------- |
| `VSCE_PAT` | Visual Studio Marketplace publishing for publisher `Runzelee` |
| `OVSX_PAT` | Open VSX publishing for namespace `Runzelee`                  |

Do not put either token in this repository, a release script, a command-line
argument, or an Actions variable. The workflow passes tokens only through the
standard environment variables consumed by `vsce` and `ovsx`.

### Visual Studio Marketplace

The extension and publisher already exist in the Visual Studio Marketplace.
For the current PAT-based workflow, create an Azure DevOps token with:

- Organization: **All accessible organizations**
- Scope: **Marketplace → Manage**

Save its value as the GitHub Actions secret `VSCE_PAT`. If this secret is not
configured, the workflow skips Visual Studio Marketplace publishing without
failing the Open VSX release.

Microsoft retires global Azure DevOps PATs on 2026-12-01. This PAT integration
is therefore transitional. Before that date, migrate the Marketplace job to
Microsoft Entra ID workload identity and `vsce publish --azure-credential`.
The official setup currently requires authorizing the managed identity as a
Contributor on the Marketplace publisher.

Official documentation:

- <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
- <https://code.visualstudio.com/api/working-with-extensions/continuous-integration#automated-publishing>

### Open VSX

Before the first Open VSX publish:

1. Sign in to <https://open-vsx.org> with the GitHub account associated with the
   publisher.
2. Link the Eclipse account and accept the Publisher Agreement.
3. Create an access token and save it as `OVSX_PAT`.
4. If namespace `Runzelee` does not exist yet, create it once from a trusted
   terminal with `OVSX_PAT` set in the environment:

    ```bash
    npx ovsx create-namespace Runzelee
    ```

Official documentation:
<https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions>

## Release flow

1. Update `packages/mcu-debug/package.json` to the new version and commit it.
2. Push the release commit.
3. Create and push a matching tag, for example:

    ```bash
    git tag v0.1.4
    git push origin main v0.1.4
    ```

The tag must exactly equal `v` plus the extension version. The workflow stops
before publishing when they differ.

This checkout also contains tags fetched from upstream. `v0.1.4` is currently
available, but local tags `v0.1.5` through `v0.1.12`, plus `v0.1.14` and
`v0.1.15`, already belong to upstream. Do not move or reuse those tags; choose
an unoccupied version, or deliberately switch to a fork-specific tag prefix
before reaching them.

The workflow then:

1. Builds Linux/Windows helper binaries on Ubuntu and Darwin binaries on macOS.
2. Consolidates all five platform binaries.
3. Packages exactly one unified VSIX.
4. Verifies the VSIX contains every expected native helper.
5. Uploads the VSIX as an Actions artifact and a GitHub Release asset.
6. Publishes the same artifact to Open VSX and, when `VSCE_PAT` is configured,
   Visual Studio Marketplace in two independent jobs.

If only one registry fails, use **Re-run failed jobs** in GitHub Actions. The
successful registry is not republished and the Darwin binaries are not rebuilt.
