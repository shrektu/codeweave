# Releasing Codeweave

Releases are built by `.github/workflows/release.yml` and published as a draft
GitHub Release. Nothing is published automatically: a maintainer reviews the
draft and presses Publish.

## Cutting a release

1. Bump `version` in `package.json` in a pull request and merge it.
2. Tag the merge commit and push the tag. The tag must be `v` followed by the
   exact `package.json` version, otherwise the `version` job fails before
   anything is built.
   - Stable release: `v0.2.0`
   - Beta: `v0.2.0-beta.1` (any version with a `-` suffix)
3. The workflow builds all targets, then the `publish` job creates a draft
   release named `Codeweave <version>` with generated notes (grouped by the
   `enhancement` and `bug` labels, see `.github/release.yml`) and attaches all
   installers and update manifests. Re-running the workflow for the same tag
   uploads the files again and overwrites the existing ones.
4. Review the draft, test an installer, then publish it.

Versions with a `-` suffix are marked as GitHub prereleases. Publish them as
prereleases so that they are not offered as the latest stable version.

Pull requests that touch `electron-builder.yml`, `package.json`, `build/`,
`scripts/release/` or the workflow itself run the same build without the
publish job, which never runs outside a `v*` tag.

## What each system gets

| System | Runner | Files |
| --- | --- | --- |
| Linux x64 | `ubuntu-latest` | `Codeweave-<version>.AppImage`, `codeweave_<version>_amd64.deb`, `codeweave-<version>.x86_64.rpm`, `latest-linux.yml` |
| Linux arm64 | `ubuntu-24.04-arm` | `Codeweave-<version>-arm64.AppImage`, `codeweave_<version>_arm64.deb`, `codeweave-<version>.aarch64.rpm`, `latest-linux-arm64.yml` |
| Windows x64 and arm64 | `windows-latest` | `Codeweave-Setup-<version>.exe` (one installer for both architectures), `latest.yml` |
| macOS x64 and arm64 | `macos-latest` | `Codeweave-<version>-x64.dmg`, `Codeweave-<version>-arm64.dmg`, matching `.zip` files, `latest-mac.yml` |

The app icons (`build/icon.png`, `build/icons/`, `build/icon.ico`,
`build/icon.icns`) are generated from `build/icon.svg`. Regenerate them with
`node scripts/release/icon.ts`; it needs a display or `xvfb-run`.

The AppImage needs FUSE 2 on the user's machine. Without it, start it with
`--appimage-extract-and-run` or set `APPIMAGE_EXTRACT_AND_RUN=1`.

Each job builds natively. `node-pty` is an N-API module: Linux uses the
`build/Release/pty.node` compiled during `pnpm install`, Windows and macOS use
the prebuilds shipped inside the package. Windows and macOS jobs install with
`--cpu x64 --cpu arm64` so the packages of both architectures are present.

After packaging, `scripts/release/nativeArch.ts` checks every packaged app:
all native files must contain the target architecture, only the matching
`@anthropic-ai/claude-agent-sdk-<platform>-<arch>` package may be present, and
that package must not be missing. A violation fails the job. To run the check
by hand: `node scripts/release/nativeArch.ts release`.

## Unsigned builds

When the signing secrets below are not configured, the workflow still builds
and publishes, but the installers are unsigned.

- Windows: SmartScreen shows "Windows protected your PC". Choose "More info",
  then "Run anyway".
- macOS: the app is ad-hoc signed (so Apple silicon does not report it as
  damaged) but not notarized, so Gatekeeper still blocks the first launch.
  Right-click the app and choose Open, or use System Settings, Privacy and
  Security, Open Anyway. Alternatively remove the quarantine flag:
  `xattr -dr com.apple.quarantine /Applications/Codeweave.app`.
- Linux: no signing is involved.

## Signing configuration

Signing is switched on by the presence of the values. A partial set is an
error: the build stops and names the missing variables (never their values).
Configure them under Settings, Secrets and variables, Actions of the
repository.

### macOS

| Name | Kind | Holds | Where to get it |
| --- | --- | --- | --- |
| `MAC_CSC_LINK` | secret | Base64 of the Developer ID Application certificate as `.p12` | Export from Keychain Access, then `base64 -i cert.p12` |
| `MAC_CSC_KEY_PASSWORD` | secret | Password of that `.p12` | Chosen while exporting |
| `APPLE_ID` | secret | Apple ID used for notarization | Apple Developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret | App-specific password for that Apple ID | appleid.apple.com, Sign-In and Security |
| `APPLE_TEAM_ID` | secret | 10-character team identifier | Apple Developer, Membership details |

Without `MAC_CSC_LINK` the macOS build is unsigned and not notarized. With it
the app is signed with the hardened runtime and the entitlements in
`build/entitlements.mac.plist`. Notarization runs when all three `APPLE_*`
secrets are set; setting only some of them fails the build.

### Windows (Azure Trusted Signing)

| Name | Kind | Holds | Where to get it |
| --- | --- | --- | --- |
| `AZURE_TENANT_ID` | secret | Microsoft Entra tenant ID | Entra ID overview |
| `AZURE_CLIENT_ID` | secret | Application (client) ID of the signing app registration | Entra ID, App registrations |
| `AZURE_CLIENT_SECRET` | secret | Client secret of that app registration | Entra ID, Certificates and secrets |
| `AZURE_SIGNING_ENDPOINT` | variable | Regional Trusted Signing endpoint, for example `https://eus.codesigning.azure.net` | Trusted Signing account overview |
| `AZURE_SIGNING_ACCOUNT` | variable | Trusted Signing account name | Azure portal |
| `AZURE_SIGNING_PROFILE` | variable | Certificate profile name | Trusted Signing account, Certificate profiles |
| `AZURE_SIGNING_PUBLISHER` | variable | Publisher name of the certificate, for example `CN=Example` | Certificate profile subject |

All seven values must be set for Windows signing; none set builds unsigned.
The app registration needs the Trusted Signing Certificate Profile Signer role
on the account.
