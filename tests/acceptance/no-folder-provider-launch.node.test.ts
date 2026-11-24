import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRig, removeRigDirs, startHandle } from "../fakes/fakeAcpAgent";
import {
  createAgyRig,
  removeAgyRigDirs,
  startAgyHandle,
} from "../fakes/fakeAgy";
import {
  createCodexRig,
  removeCodexRigDirs,
  serverOf,
} from "../fakes/fakeCodexAppServer";
import {
  createOpencodeRig,
  disposeOpencodeRigs,
  opencodeServerOf,
  startOpencodeHandle,
} from "../fakes/fakeOpencodeServer";

const NESTED_REPO = "repo";

afterEach(async () => {
  await Promise.all([
    removeRigDirs(),
    removeCodexRigDirs(),
    removeAgyRigDirs(),
    disposeOpencodeRigs(),
  ]);
});

async function nestRepo(workspace: string): Promise<string> {
  const repo = join(workspace, NESTED_REPO);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

describe("no-folder start launches providers in the workspace itself", () => {
  it("claude-acp-launches-in-the-resolved-workspace", async () => {
    const rig = await createRig();
    const repo = await nestRepo(rig.cwd);

    await startHandle(rig);

    expect(rig.container.specs.map((spec) => spec.cwd)).toEqual([rig.cwd]);
    expect(rig.container.specs[0]?.cwd).not.toBe(repo);
  });

  it("codex-app-server-launches-in-the-resolved-workspace", async () => {
    const rig = await createCodexRig();
    const repo = await nestRepo(rig.cwd);

    const result = await rig.start();

    expect(result.ok).toBe(true);
    expect(rig.container.specs.map((spec) => spec.cwd)).toEqual([rig.cwd]);
    expect(
      serverOf(rig)
        .paramsOf("thread/start")
        .map((params) => (params as { cwd: string }).cwd),
    ).toEqual([rig.cwd]);
    expect(rig.cwd).not.toBe(repo);
  });

  it("opencode-serve-launches-in-the-resolved-workspace", async () => {
    const rig = await createOpencodeRig();
    await nestRepo(rig.cwd);

    await startOpencodeHandle(rig);

    expect(rig.container.specs.map((spec) => spec.cwd)).toEqual([rig.cwd]);
    const { requests } = opencodeServerOf(rig);
    expect(requests.map((request) => request.query.directory)).toEqual([
      rig.cwd,
      rig.cwd,
      rig.cwd,
    ]);
  });

  it("agy-launches-in-the-resolved-workspace", async () => {
    const rig = await createAgyRig();
    await nestRepo(rig.cwd);

    await startAgyHandle(rig);

    expect(rig.container.agySpawns().map((spawn) => spawn.spec.cwd)).toEqual([
      rig.cwd,
    ]);
  });
});
