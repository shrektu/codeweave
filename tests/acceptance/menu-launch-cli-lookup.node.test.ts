import { mkdir, readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { buildAgentEnv } from "../../src/backend/env";
import {
  isDirectory,
  readLoginShellPath,
  resolveLaunchEnv,
} from "../../src/backend/launchEnv";
import { createExecutableResolver } from "../../src/backend/startup";
import { isRunnableFileSync } from "../../src/backend/terminal/shell";
import { ProviderId, type Account } from "../../src/domain/types";
import {
  createBackendTerminalRig,
  type BackendTerminalRig,
} from "../fakes/fakeTerminal";
import { isAlive, makeTempDir, WAIT_TIMEOUT_MS } from "../fakes/processHelpers";

const EXECUTABLE_MODE = 0o755;
const SHELL_TIMEOUT_MS = 3000;
const HANGING_SHELL_TIMEOUT_MS = 200;
const HANG_SECONDS = 30;
const FAST_RESULT_LIMIT_MS = 5000;
const FAKE_KEY = "fake-key";
const FAKE_PROBE = "fake";
const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 30;
const PATH_SEPARATOR = posix.delimiter;

const rigs: BackendTerminalRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

function desktopSessionPath(home: string): string {
  return [
    posix.join(home, ".cargo", "bin"),
    "/snap/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(PATH_SEPARATOR);
}

async function installCli(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = posix.join(dir, name);
  await writeFile(path, "", { mode: EXECUTABLE_MODE });
  return path;
}

interface FakeShell {
  readonly path: string;
  readonly argvFile: string;
  readonly pidFile: string;
}

async function writeFakeShell(
  dir: string,
  lines: readonly string[],
): Promise<FakeShell> {
  const path = posix.join(dir, "fake-shell");
  const argvFile = posix.join(dir, "argv.txt");
  const pidFile = posix.join(dir, "pid.txt");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${argvFile}"`,
    `echo $$ > "${pidFile}"`,
    ...lines,
    "",
  ].join("\n");
  await writeFile(path, script, { mode: EXECUTABLE_MODE });
  return { path, argvFile, pidFile };
}

function launchDeps(
  env: NodeJS.ProcessEnv,
  home: string,
  shell: string | null,
  timeoutMs: number,
): Parameters<typeof resolveLaunchEnv>[0] {
  return {
    env,
    platform: process.platform,
    homeDir: home,
    userShell: shell,
    readShellPath: (path) =>
      readLoginShellPath(path, { env, cwd: home, timeoutMs }),
    isDirectory,
    isExecutable: (path) => isRunnableFileSync(path, process.platform),
  };
}

function outcomeOf(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(PATH_SEPARATOR);
}

const account: Account = {
  id: "acc-1",
  provider: ProviderId.codex,
  label: "Codex",
  configDir: "/home/jane/.codex",
  order: 0,
};

const posixIt = it.skipIf(process.platform === "win32");

posixIt(
  "finds_every_cli_installed_only_in_user_level_directories",
  async () => {
    const home = await makeTempDir();
    const localBin = posix.join(home, ".local", "bin");
    const claude = await installCli(localBin, "claude");
    const codex = await installCli(localBin, "codex");
    const agy = await installCli(localBin, "agy");
    const opencode = await installCli(
      posix.join(home, ".opencode", "bin"),
      "opencode",
    );
    const env = { HOME: home, PATH: desktopSessionPath(home) };

    const launchEnv = await resolveLaunchEnv(
      launchDeps(env, home, null, SHELL_TIMEOUT_MS),
    );
    const resolve = createExecutableResolver(launchEnv, process.platform);

    expect({
      claude: outcomeOf(() => resolve(ProviderId.claude, null)),
      codex: outcomeOf(() => resolve(ProviderId.codex, null)),
      agy: outcomeOf(() => resolve(ProviderId.gemini, null)),
      opencode: outcomeOf(() => resolve(ProviderId.opencode, null)),
    }).toEqual({ claude, codex, agy, opencode });
  },
);

posixIt("puts_the_login_shell_path_first", async () => {
  const home = await makeTempDir();
  const custom = posix.join(home, "custom-bin");
  const shell = await writeFakeShell(home, [
    "echo 'welcome banner'",
    `PATH="${custom}:$PATH"`,
    'eval "$2"',
  ]);
  const env = { HOME: home, PATH: desktopSessionPath(home) };

  const launchEnv = await resolveLaunchEnv(
    launchDeps(env, home, shell.path, SHELL_TIMEOUT_MS),
  );

  const expected = [custom, ...pathEntries(env)];
  expect(pathEntries(launchEnv).slice(0, expected.length)).toEqual(expected);
  const argv = (await readFile(shell.argvFile, "utf8")).split("\n");
  expect(argv[0]).toBe("-ilc");
});

posixIt("falls_back_to_known_dirs_when_the_shell_hangs", async () => {
  const home = await makeTempDir();
  const localBin = posix.join(home, ".local", "bin");
  await mkdir(localBin, { recursive: true });
  const shell = await writeFakeShell(home, [`sleep ${String(HANG_SECONDS)}`]);
  const env = { HOME: home, PATH: desktopSessionPath(home) };
  const startedAt = Date.now();

  const launchEnv = await resolveLaunchEnv(
    launchDeps(env, home, shell.path, HANGING_SHELL_TIMEOUT_MS),
  );

  expect(Date.now() - startedAt).toBeLessThan(FAST_RESULT_LIMIT_MS);
  expect(pathEntries(launchEnv)).toContain(localBin);
  const pid = Number((await readFile(shell.pidFile, "utf8")).trim());
  await vi.waitFor(
    async () => {
      expect(await isAlive(pid)).toBe(false);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
});

posixIt("resolves_when_a_background_child_keeps_stdout_open", async () => {
  const home = await makeTempDir();
  const custom = posix.join(home, "custom-bin");
  const shell = await writeFakeShell(home, [
    `sleep ${String(HANG_SECONDS)} &`,
    `PATH="${custom}:$PATH"`,
    'eval "$2"',
  ]);
  const env = { HOME: home, PATH: desktopSessionPath(home) };
  const startedAt = Date.now();

  const launchEnv = await resolveLaunchEnv(
    launchDeps(env, home, shell.path, WAIT_TIMEOUT_MS),
  );

  expect(Date.now() - startedAt).toBeLessThan(FAST_RESULT_LIMIT_MS);
  expect(pathEntries(launchEnv)[0]).toBe(custom);
});

posixIt(
  "agents_and_terminal_get_the_lookup_path_and_nothing_from_the_shell",
  async () => {
    const home = await makeTempDir();
    const custom = posix.join(home, "custom-bin");
    const shell = await writeFakeShell(home, [
      `export ANTHROPIC_API_KEY=${FAKE_KEY} CODEWEAVE_PROBE=${FAKE_PROBE}`,
      `PATH="${custom}:$PATH"`,
      'eval "$2"',
    ]);
    const env = { HOME: home, PATH: desktopSessionPath(home) };

    const launchEnv = await resolveLaunchEnv(
      launchDeps(env, home, shell.path, SHELL_TIMEOUT_MS),
    );

    expect(pathEntries(launchEnv)[0]).toBe(custom);
    expect({ ...launchEnv, PATH: env.PATH }).toEqual(env);
    const agentEnv = buildAgentEnv({
      parent: launchEnv,
      platform: process.platform,
      homeDir: home,
      account,
      executable: "/usr/bin/codex",
      runMarker: "run-1",
      testMode: false,
    });
    expect(agentEnv.PATH).toBe(launchEnv.PATH);
    expect(agentEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(agentEnv).not.toHaveProperty("CODEWEAVE_PROBE");

    const rig = await createBackendTerminalRig(launchEnv);
    rigs.push(rig);
    const response = await rig.connect().request("terminal/open", {
      cwd: rig.cwd,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    });
    expect(response).toMatchObject({ ok: true });
    const terminalEnv = rig.spawns[0]?.options.env;
    expect(terminalEnv?.PATH).toBe(launchEnv.PATH);
    expect(terminalEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(terminalEnv).not.toHaveProperty("CODEWEAVE_PROBE");
  },
);
