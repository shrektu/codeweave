# Codeweave

Electron + React + TypeScript desktop app. The orchestration backend runs in an
Electron `utilityProcess` and talks to the renderer over a `MessagePort` with a
zod-validated, versioned protocol (`src/shared/protocol.ts`).

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

In CI, `tests/e2e/terminal.spec.ts` also drives the packed app on all three
systems: `CODEWEAVE_E2E_EXECUTABLE` points at the unpacked executable, for
example `release/linux-unpacked/codeweave`. Outside CI the spec skips this
mode, because the packed app ignores `CODEWEAVE_USER_DATA_DIR` and would use
your real profile.
