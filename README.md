# Codeweave

Electron + React + TypeScript desktop app. The orchestration backend runs in an
Electron `utilityProcess` and talks to the renderer over a `MessagePort` with a
zod-validated, versioned protocol (`src/shared/protocol.ts`).

## Download and releases

Installers for Linux (AppImage, deb, rpm), Windows (NSIS) and macOS (dmg, zip)
are attached to the [GitHub Releases](https://github.com/shrektu/codeweave/releases)
page. Builds are unsigned until signing credentials are configured, so the
first launch needs an extra step on Windows and macOS. The AppImage needs FUSE 2
(`libfuse2t64` on Ubuntu 24.04 and newer, `libfuse2` before that); the deb and
rpm packages do not. Cutting a release and
the signing setup are described in [docs/releasing.md](docs/releasing.md).

## Requirements

- Node.js 24 or newer
- pnpm 12 (`corepack enable` picks the version from `package.json`)

## Install

```sh
pnpm install
```

## Develop

```sh
pnpm dev
```

## Agents

Flow nodes run agents. An agent is defined in a Markdown file directly in the
`agents/` folder of your repository. Each definition is a YAML front-matter
block followed by the instructions the agent gets as its prompt; one file may
hold several agents, each starting with its own `---` block.

```md
---
id: docs-writer
role: Writes the docs
provider: claude
model: sonnet
permissionProfile: accept-edits
taskClass: M
---

Write the docs for the change.
```

- `id`, `role`, `provider` (`claude`, `codex`, `gemini` or `opencode`) and
  `permissionProfile` (`bypass`, `unattended`, `accept-edits`, `ask` or `plan`)
  are required.
- `model` and `taskClass` are optional. The editor suggests models from the
  OpenCode catalog for OpenCode agents only; for other providers `model` is
  free text. Codeweave does not pass `model` to the agent CLI yet.
- The text after the front matter is the agent's instructions.

The **Agents** tab creates, edits, renames and deletes these files after you
pick the repository folder. Renaming or deleting an agent is refused while a
flow uses it; the tab lists the flows that do. Saved changes apply to the next
flow run without restarting the app.

![The Agents tab with an agent open](docs/screenshots/agent-editor.png)

## Terminal

A terminal docks at the bottom of the centre column. Toggle it with the
`Terminal` button in the header or with ``Ctrl+` `` (backquote); drag the splitter
above it, or focus the splitter and use the arrow keys, to resize it.

- The shell starts in the session folder. Without a session, `Open in folder…`
  asks for one.
- The shell is detected automatically: `$SHELL` on macOS and Linux, PowerShell
  on Windows. Set a different one under Settings → Terminal shell; leave it
  empty to detect again.
- Hiding the dock keeps the shell running; showing it again replays the recent
  output. `Close` ends the shell. A shell that exits shows its exit code and a
  `Restart` button.
- The renderer is WebGL when the GPU is accelerated and falls back to DOM
  rendering otherwise or when the WebGL context is lost.

## Updates

Codeweave checks the GitHub Releases of `shrektu/codeweave` at start and every
6 hours. It only notifies: a banner offers a `View release` link, and nothing
is downloaded or installed. In Settings you can switch the check off and pick
the Stable or Beta (pre-releases) channel.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## Build, end-to-end tests and packaging

The end-to-end tests drive the built app in `out/`, so build first:

```sh
pnpm build
pnpm e2e
pnpm run pack
```

`pnpm pack` is a built-in pnpm command, so the unpacked build is started with
`pnpm run pack` (output in `release/`).

Release installers are built per operating system on a native runner with
`node scripts/release/build.ts <linux|windows|mac>` after `pnpm build`. The
script runs electron-builder with the signing options that the available
environment variables allow and then checks that every packaged app holds only
binaries of its own architecture. The release workflow
(`.github/workflows/release.yml`) runs it for every `v*` tag; see
[docs/releasing.md](docs/releasing.md).

In CI, `tests/e2e/terminal.spec.ts` also drives the packed app on all three
systems: `CODEWEAVE_E2E_EXECUTABLE` points at the unpacked executable, for
example `release/linux-unpacked/codeweave`. Outside CI the spec skips this
mode, because the packed app ignores `CODEWEAVE_USER_DATA_DIR` and would use
your real profile.
