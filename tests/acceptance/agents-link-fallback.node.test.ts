import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, saveAgent } from "../../src/backend/agents";
import { listFlows } from "../../src/backend/flows";
import type { AgentDefinition } from "../../src/domain/flows";
import { projectRoots } from "../fakes/definitionRoots";
import { makeTempDir } from "../fakes/processHelpers";

const faults = vi.hoisted(() => ({
  linkCode: undefined as string | undefined,
  renameFails: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (existing: string, target: string): Promise<void> => {
      if (faults.linkCode === undefined) {
        return actual.link(existing, target);
      }
      return Promise.reject(
        Object.assign(new Error(`link failed: ${faults.linkCode}`), {
          code: faults.linkCode,
        }),
      );
    },
    rename: (from: string, to: string): Promise<void> => {
      if (faults.renameFails) {
        return Promise.reject(new Error("rename exploded"));
      }
      return actual.rename(from, to);
    },
  };
});

const CODER_FILE = "agents/coder.md";
const UNSUPPORTED_CODES = ["EPERM", "ENOTSUP", "EXDEV", "EISDIR"] as const;

const CODER_TEXT = `---
id: coder
role: Writes code
provider: claude
permissionProfile: plan
---

Prompt
`;

const BUILDER_TEXT = `---
id: builder
role: Builds things
provider: claude
permissionProfile: plan
---

Prompt
`;

const CODER: AgentDefinition = {
  id: "coder",
  role: "Writes code",
  provider: "claude",
  permissionProfile: "plan",
};

async function project(files: Record<string, string>): Promise<string> {
  const cwd = await makeTempDir();
  for (const [relative, content] of Object.entries(files)) {
    const file = join(cwd, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  return cwd;
}

async function agentFiles(cwd: string): Promise<string[]> {
  return (await readdir(join(cwd, "agents"))).sort();
}

beforeEach(() => {
  faults.linkCode = undefined;
  faults.renameFails = false;
});

afterEach(() => {
  faults.linkCode = undefined;
  faults.renameFails = false;
});

describe.each(UNSUPPORTED_CODES)("when link() fails with %s", (code) => {
  it("create_agent_without_hard_links_writes_the_file", async () => {
    const cwd = await project({});
    faults.linkCode = code;

    const result = await createAgent(projectRoots(cwd), {
      agent: CODER,
      body: "Prompt",
    });

    expect(await agentFiles(cwd)).toEqual(["coder.md"]);
    expect(await readFile(join(cwd, CODER_FILE), "utf8")).toBe(CODER_TEXT);
    expect(result.agents.map(({ id }) => id)).toEqual(["coder"]);
  });

  it("rename_agent_without_hard_links_moves_the_file", async () => {
    const cwd = await project({ [CODER_FILE]: CODER_TEXT });
    const { agents } = await listFlows(projectRoots(cwd));
    faults.linkCode = code;

    await saveAgent(projectRoots(cwd), {
      source: "project",
      file: CODER_FILE,
      revision: agents[0]?.revision ?? "",
      id: "coder",
      agent: { ...CODER, id: "builder" },
      body: "Prompt",
    });

    expect(await agentFiles(cwd)).toEqual(["builder.md"]);
    expect(await readFile(join(cwd, "agents/builder.md"), "utf8")).toBe(
      BUILDER_TEXT.replace("Builds things", "Writes code"),
    );
  });

  it("create_agent_without_hard_links_keeps_an_existing_file", async () => {
    const cwd = await project({ [CODER_FILE]: BUILDER_TEXT });
    faults.linkCode = code;

    await expect(
      createAgent(projectRoots(cwd), { agent: CODER, body: "Other" }),
    ).rejects.toThrow("An agent file named coder.md already exists");

    expect(await agentFiles(cwd)).toEqual(["coder.md"]);
    expect(await readFile(join(cwd, CODER_FILE), "utf8")).toBe(BUILDER_TEXT);
  });
});

describe("link failures outside the fallback set", () => {
  it("unrelated_link_error_propagates_without_creating_a_file", async () => {
    const cwd = await project({});
    faults.linkCode = "EACCES";

    await expect(
      createAgent(projectRoots(cwd), { agent: CODER, body: "Prompt" }),
    ).rejects.toThrow("link failed: EACCES");

    expect(await agentFiles(cwd)).toEqual([]);
  });
});

describe("rename failure after the placeholder was reserved", () => {
  it("failed_rename_after_reservation_leaves_no_files", async () => {
    const cwd = await project({});
    faults.linkCode = "EPERM";
    faults.renameFails = true;

    await expect(
      createAgent(projectRoots(cwd), { agent: CODER, body: "Prompt" }),
    ).rejects.toThrow("rename exploded");

    expect(await agentFiles(cwd)).toEqual([]);
  });
});
