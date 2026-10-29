import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexLoginError, loginWithApiKey } from "../e2e/codexRotationFixture";

const LOCAL_URL = "http://127.0.0.1:4010/v1";
const FAKE_KEY = "fixture-key";
const FAILING_EXECUTABLE = "false";
const SUCCEEDING_EXECUTABLE = "true";
const MISSING_EXECUTABLE = "codex-binary-that-does-not-exist";
const WITHOUT_POSIX_TOOLS = process.platform === "win32";

const created: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-login-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("codex login fixture", () => {
  it.skipIf(WITHOUT_POSIX_TOOLS)("login_failure_is_reported", async () => {
    const home = await tempHome();

    const failure = loginWithApiKey(
      home,
      LOCAL_URL,
      FAKE_KEY,
      FAILING_EXECUTABLE,
    );

    await expect(failure).rejects.toBeInstanceOf(CodexLoginError);
    await expect(failure).rejects.toThrow(/exit code 1/);
  });

  it("login_spawn_failure_is_reported", async () => {
    const home = await tempHome();

    await expect(
      loginWithApiKey(home, LOCAL_URL, FAKE_KEY, MISSING_EXECUTABLE),
    ).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(WITHOUT_POSIX_TOOLS)(
    "login_succeeds_when_the_executable_exits_zero",
    async () => {
    const home = await tempHome();

    await expect(
      loginWithApiKey(home, LOCAL_URL, FAKE_KEY, SUCCEEDING_EXECUTABLE),
    ).resolves.toBeUndefined();
  });

  it("login_checks_the_guard_before_spawning", async () => {
    await expect(
      loginWithApiKey(
        join(homedir(), ".codex"),
        LOCAL_URL,
        FAKE_KEY,
        SUCCEEDING_EXECUTABLE,
      ),
    ).rejects.toThrow(/real codex home/);
  });
});
