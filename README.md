# Codeweave

Electron + React + TypeScript desktop app. The orchestration backend runs in an
Electron `utilityProcess` and talks to the renderer over a `MessagePort` with a
zod-validated, versioned protocol (`src/shared/protocol.ts`).

## Download and install

Installers for Linux, Windows and macOS are attached to the
[GitHub Releases](https://github.com/shrektu/codeweave/releases) page. Builds
are unsigned until signing credentials are configured, so the first launch
needs an extra step on Windows and macOS. Cutting a release and the signing
setup are described in [docs/releasing.md](docs/releasing.md).

### Linux

Pick the package for your distribution and architecture. File names below are
for x64; the arm64 files are `Codeweave-<version>-arm64.AppImage`,
`codeweave_<version>_arm64.deb` and `codeweave-<version>.aarch64.rpm`.

- AppImage (`Codeweave-<version>.AppImage`): make it executable and run it.

  ```sh
  chmod +x Codeweave-<version>.AppImage
  ./Codeweave-<version>.AppImage
  ```

  The AppImage needs FUSE 2: install `libfuse2t64` on Ubuntu 24.04 and newer,
  `libfuse2` before that. Without FUSE run
  `./Codeweave-<version>.AppImage --appimage-extract-and-run`, or set
  `APPIMAGE_EXTRACT_AND_RUN=1`.
- Debian and Ubuntu (`codeweave_<version>_amd64.deb`):
  `sudo apt install ./codeweave_<version>_amd64.deb`
- Fedora and RHEL (`codeweave-<version>.x86_64.rpm`):
  `sudo dnf install ./codeweave-<version>.x86_64.rpm`

The deb and rpm packages do not need FUSE.

### Windows

Run `Codeweave-Setup-<version>.exe`. It installs per user and lets you choose
the directory. While the installer is unsigned, SmartScreen shows "Windows
protected your PC": choose "More info", then "Run anyway".

### macOS

Download `Codeweave-<version>-x64.dmg` (Intel) or
`Codeweave-<version>-arm64.dmg` (Apple silicon), open it and drag Codeweave to
Applications. The matching `.zip` files hold the same app. The app is not
notarized yet, so the first launch needs an extra step, described under
"Unsigned builds" in [docs/releasing.md](docs/releasing.md).

## Build from source

Requirements:

- Node.js 24 or newer
- pnpm 12 (`corepack enable` picks the version from `package.json`)

```sh
pnpm install
```

## Develop

```sh
pnpm dev
```

## Agent CLIs

Codeweave runs your installed `claude`, `codex`, `agy` and `opencode` CLIs and
finds them like this:

- The app's own `PATH`.
- On Linux and macOS also the `PATH` of your login shell. Codeweave reads it
  once, when the app starts, by running `$SHELL -ilc` with a 3 second limit, so
  a CLI that only your shell profile puts on `PATH` is found even when you start
  Codeweave from the desktop menu, the Dock or Finder.
- On Linux and macOS also the usual user directories that exist: `~/.local/bin`,
  `~/.opencode/bin`, `~/.cargo/bin`, `~/.bun/bin`, `~/.npm-global/bin`,
  `~/.volta/bin`, pnpm and fnm directories, and Homebrew
  (`/opt/homebrew/bin`, `/usr/local/bin` on macOS,
  `/home/linuxbrew/.linuxbrew/bin` on Linux).
- On Windows only the app's `PATH`.

To use a CLI from another place, set its full path under Settings → Claude
executable, Codex executable, OpenCode executable or Gemini executable (agy).

Restart Codeweave after installing a CLI into a new directory or after changing
your shell's `PATH`. Agents and the integrated terminal run with the same
`PATH` the lookup uses. Only `PATH` is taken from your shell; its other
variables are not passed on.

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
taskClass: standard
---

Write the docs for the change.
```

- `id`, `role`, `provider` (`claude`, `codex`, `gemini` or `opencode`) and
  `permissionProfile` (`bypass`, `unattended`, `accept-edits`, `ask` or `plan`)
  are required.
- `model` and `taskClass` are optional. The editor suggests models from the
  OpenCode catalog for OpenCode agents only; for other providers `model` is
  free text. Leave it empty or set `auto` to let task-class routing choose.
  Every agent CLI receives the model with each turn, in the format of its
  provider:
  - Claude: an alias (`sonnet`, `opus`, `haiku`) or a model id Claude Code lists.
  - Codex: a Codex model id.
  - Gemini: a model name as `agy models` shows it, for example
    `Gemini 4 Hydrogen (Medium)`.
  - OpenCode: `<provider>/<model>`, for example `groq/openai/gpt-oss-20b`.
- `taskClass` is `light`, `standard` or `heavy`. On OpenCode API-key accounts
  Codeweave picks a model per turn from the class; subscription accounts keep
  the CLI default. The composer lets you choose a class and a model for the next
  prompt, and every turn shows a badge with the model that handled it. Details
  in [docs/model-routing.md](docs/model-routing.md).
- The text after the front matter is the agent's instructions.

The **Agents** tab creates, edits, renames and deletes these files after you
pick the repository folder. Renaming or deleting an agent is refused while a
flow uses it; the tab lists the flows that do. Saved changes apply to the next
flow run without restarting the app.

![The Agents tab with an agent open](docs/screenshots/agent-editor.png)

### Flow library

Agents and flows you use in many repositories can live in one library folder
instead of being copied into each repository. Codeweave reads the `agents/`
and `flows/` folders of the library together with the repository's own. Set
the folder under Settings → Flow library folder (an absolute path; `~` stands
for your home folder); when it is empty, Codeweave uses `library` in its data
folder.

- A repository definition with the same id overrides the library one.
- The Flow and Agents tabs and the orchestrator's `list_flows` mark each
  definition as Project or Library.
- Editing a library definition writes to the library folder; a new agent goes
  to the place you pick in its Location field.
- Flows from the library still run in the opened repository.

## OpenCode accounts

OpenCode accounts sign in with an API key or, for OpenCode Go and OpenCode Zen,
with the OpenCode Console login of opencode 2.2.5 or newer. The providers are
Groq, Cerebras, OpenRouter, Google AI Studio, Mistral, Z.ai, DeepSeek, Kimi
(Moonshot), OpenCode Go, OpenCode Zen and Custom OpenAI-compatible. Keys are
encrypted with the OS keychain (Electron safeStorage) and kept out of the
account's config directory.

Codeweave needs the `opencode` CLI on `PATH`. Two generations are supported:
1.19.x (`npm i -g opencode-ai@1.19.5`) and 2.2.5 or newer
(`npm i -g @opencode/cli`). Codeweave runs `opencode --version` at each start
to pick the matching driver and refuses any other version with a message. The
HTTP API of OpenCode 2.x is marked experimental upstream; Codeweave is tested
with 2.2.5 and 2.3.2.

### OpenCode Go

Subscribe in the OpenCode Console, then either copy the API key or use the
Console login (see below), and add an OpenCode account with the provider
"OpenCode Go". One provider covers Go, Go Plus and Go Teams.
There is no base URL to enter: Codeweave uses OpenCode's built-in endpoint
`https://opencode.ai/inference/go`. The models and the class defaults are listed
in [docs/model-routing.md](docs/model-routing.md).

- Limits are dollars of usage per 5 hours, week and month, enforced by
  OpenCode. When a limit is hit the turn ends as a rate limit and Codeweave
  rotates to the next account at the turn boundary, keeping the reset time when
  OpenCode reports one.
- If Extra Usage is on in the Console, a reached limit is billed to your
  balance and nothing rotates.
- Models gated by the Console privacy settings (DeepSeek, Muse Spark) must be
  enabled there first.

Rotation pool order: own subscription accounts, other subscriptions (Claude,
Codex, Gemini), OpenCode Go, free API tiers, paid API keys. Only accounts with
"Use in rotation" ticked take part.

Go support is tested against a local mock of the Go endpoint with opencode
1.19.5; it has not been run against a real subscription.

### OpenCode Console login

For OpenCode Go and OpenCode Zen you can sign in with your Console account
instead of an API key.

1. When adding the account, set "Sign in with" to "OpenCode Console login". No
   key is asked for.
2. Run the command shown on the account's row in a terminal and confirm the
   code in the browser. It looks like
   `OPENCODE_DB='<account dir>/data/opencode/opencode.db' opencode auth login opencode --method device --standalone`.
   `OPENCODE_DB` keeps the login in that account's directory only, and
   `--standalone` keeps it from going through a running opencode background
   service. Codeweave never runs the login for you.

Codeweave checks the login (`opencode auth list`) before each session and in the
background, and shows "Needs login" until it exists. The account rotates on the
Go limit like a key account. Console login needs opencode 2.2.5 or newer and is
not available with opencode 1.19.x.

To log out, run
`OPENCODE_DB='<account dir>/data/opencode/opencode.db' opencode auth logout opencode --standalone`.

## Terminal

A terminal docks at the bottom of the centre column. Toggle it with the
`Terminal` button in the header or with ``Ctrl+` `` (backquote); drag the splitter
above it, or focus the splitter and use the arrow keys, to resize it.

- The shell starts in the session folder. Without a session, `Open in folder…`
  asks for one.
- The shell is detected automatically: `$SHELL` on macOS and Linux, PowerShell
  on Windows. Set a different one under Settings → Terminal shell; leave it
  empty to detect again.
- The shell gets the same `PATH` the agent CLI lookup uses (see
  [Agent CLIs](#agent-clis)).
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
binaries of its own architecture. The app icons in `build/` are generated from
`build/icon.svg` with `node scripts/release/icon.ts` (needs a display, or run it
under `xvfb-run`). The release workflow
(`.github/workflows/release.yml`) runs it for every `v*` tag; see
[docs/releasing.md](docs/releasing.md).

In CI, `tests/e2e/terminal.spec.ts` also drives the packed app on all three
systems: `CODEWEAVE_E2E_EXECUTABLE` points at the unpacked executable, for
example `release/linux-unpacked/codeweave`. Outside CI the spec skips this
mode, because the packed app ignores `CODEWEAVE_USER_DATA_DIR` and would use
your real profile.
