import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { locateAgyHookEntry, writeAgyHookConfig } from "./hookConfig";

const EXEC_PATH = "/opt/Codeweave/codeweave";
const HOOK_ENTRY =
  "/opt/Codeweave/resources/app.asar.unpacked/out/main/agyHook.js";
const LAUNCHER =
  'delete process.env.ELECTRON_RUN_AS_NODE;import(require("node:url").pathToFileURL(process.argv[1]).href)';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function newConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-hookcfg-"));
  dirs.push(dir);
  return dir;
}

function posixInput(
  configDir: string,
  execPath = EXEC_PATH,
): Parameters<typeof writeAgyHookConfig>[0] {
  return { configDir, execPath, hookEntry: HOOK_ENTRY, platform: "linux" };
}

async function hookCommandOf(configDir: string): Promise<string> {
  const parsed: unknown = JSON.parse(
    await readFile(join(configDir, "config", "hooks.json"), "utf8"),
  );
  const command = (
    parsed as {
      codeweave: { PreToolUse: { hooks: { command: string }[] }[] };
    }
  ).codeweave.PreToolUse[0]?.hooks[0]?.command;
  return command ?? "";
}

describe("agy hook config files", () => {
  it("wrapper_tampering_cannot_disable_gate_posix_command_is_inline", async () => {
    const configDir = await newConfigDir();

    await writeAgyHookConfig(posixInput(configDir));

    expect(await readdir(join(configDir, "config"))).toEqual(["hooks.json"]);
    expect(
      await readFile(join(configDir, "config", "hooks.json"), "utf8"),
    ).toBe(
      JSON.stringify({
        codeweave: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: `ELECTRON_RUN_AS_NODE=1 exec '${EXEC_PATH}' -e '${LAUNCHER}' '${HOOK_ENTRY}'`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
    );
  });

  it("wrapper_tampering_cannot_disable_gate_windows_command_is_inline", async () => {
    const configDir = await newConfigDir();

    await writeAgyHookConfig({
      configDir,
      execPath: "C:\\Program Files\\Codeweave\\Codeweave.exe",
      hookEntry:
        "C:\\Codeweave\\resources\\app.asar.unpacked\\out\\main\\agyHook.js",
      platform: "win32",
    });

    expect(await readdir(join(configDir, "config"))).toEqual(["hooks.json"]);
    expect(await hookCommandOf(configDir)).toBe(
      `set "ELECTRON_RUN_AS_NODE=1" && "C:\\Program Files\\Codeweave\\Codeweave.exe" -e "${LAUNCHER.replaceAll('"', '\\"')}" "C:\\Codeweave\\resources\\app.asar.unpacked\\out\\main\\agyHook.js"`,
    );
  });
});

describe("agy hook config rewriting", () => {
  it("hook_config_rewritten_when_changed", async () => {
    const configDir = await newConfigDir();
    await writeAgyHookConfig(posixInput(configDir));

    await writeAgyHookConfig(
      posixInput(configDir, "/Applications/New/codeweave"),
    );

    const command = await hookCommandOf(configDir);
    expect(command).toContain("exec '/Applications/New/codeweave'");
    expect(command).not.toContain(EXEC_PATH);
  });

  it("wrapper_tampering_cannot_disable_gate_stale_wrappers_are_removed", async () => {
    const configDir = await newConfigDir();
    const dir = join(configDir, "config");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "hooks.json"), "{}");
    await writeFile(join(dir, "codeweave-agy-hook.sh"), "exit 0\n");
    await writeFile(join(dir, "codeweave-agy-hook.cmd"), "exit 0\r\n");

    await writeAgyHookConfig(posixInput(configDir));

    expect(await readdir(dir)).toEqual(["hooks.json"]);
    expect(
      JSON.parse(await readFile(join(dir, "hooks.json"), "utf8")),
    ).toHaveProperty("codeweave.PreToolUse");
  });

  it("unchanged_content_is_not_rewritten", async () => {
    const configDir = await newConfigDir();
    await writeAgyHookConfig(posixInput(configDir));
    const file = join(configDir, "config", "hooks.json");
    const before = await stat(file);

    await writeAgyHookConfig(posixInput(configDir));

    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("hook_command_quotes_shell_metacharacters_in_the_posix_command", async () => {
    const configDir = await newConfigDir();

    await writeAgyHookConfig(
      posixInput(configDir, "/opt/we'ird \"$dir/`x`/codeweave"),
    );

    expect(await hookCommandOf(configDir)).toContain(
      "exec '/opt/we'\\''ird \"$dir/`x`/codeweave' -e",
    );
  });
});

describe("agy hook entry location", () => {
  it("entry_is_named_after_the_electron_vite_input", () => {
    expect(locateAgyHookEntry().endsWith("agyHook.js")).toBe(true);
  });
});
