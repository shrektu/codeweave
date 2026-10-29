import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertIsolatedCodexHome } from "./codexHomeGuard";

const LOCAL_URL = "http://127.0.0.1:4010/v1";
const REMOTE_URL = "https://api.openai.com/v1";
const LOCALHOST_NAME_URL = "http://localhost:4010/v1";
const TMP_PREFIX = "codex-guard-";
const DEFAULT_HOME_DIR = ".codex";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("codex home guard", () => {
  it("guard_rejects_default_codex_home", () => {
    expect(() => {
      assertIsolatedCodexHome(join(homedir(), DEFAULT_HOME_DIR), LOCAL_URL);
    }).toThrow(/codex home/i);
  });

  it("guard_rejects_path_inside_default_codex_home", () => {
    expect(() => {
      assertIsolatedCodexHome(
        join(homedir(), DEFAULT_HOME_DIR, "nested", "home"),
        LOCAL_URL,
      );
    }).toThrow(/codex home/i);
  });

  it("guard_rejects_path_outside_tmpdir", () => {
    expect(() => {
      assertIsolatedCodexHome(join(homedir(), "elsewhere"), LOCAL_URL);
    }).toThrow(/temporary/i);
  });

  it("guard_rejects_tmp_symlink_into_default_codex_home", async () => {
    const dir = await tempDir();
    const link = join(dir, "link");
    await symlink(homedir(), link);

    expect(() => {
      assertIsolatedCodexHome(join(link, DEFAULT_HOME_DIR), LOCAL_URL);
    }).toThrow(/codex home|temporary/i);
  });

  it("guard_rejects_non_local_base_url", async () => {
    const dir = await tempDir();

    expect(() => {
      assertIsolatedCodexHome(dir, REMOTE_URL);
    }).toThrow(/127\.0\.0\.1/);
    expect(() => {
      assertIsolatedCodexHome(dir, LOCALHOST_NAME_URL);
    }).toThrow(/127\.0\.0\.1/);
  });

  it("guard_accepts_tmp_home_and_local_url", async () => {
    const dir = await tempDir();
    const home = join(dir, "home-a");
    await mkdir(home);

    expect(() => {
      assertIsolatedCodexHome(home, LOCAL_URL);
    }).not.toThrow();
  });
});
