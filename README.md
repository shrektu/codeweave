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
