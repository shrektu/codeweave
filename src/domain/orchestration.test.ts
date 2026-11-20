import { describe, expect, it } from "vitest";

import * as constants from "./constants";
import * as types from "./types";

describe("orchestration wire contract", () => {
  it("names flow placements as they travel over IPC and MCP", () => {
    expect(types).toHaveProperty("FlowPlacement", {
      inPlace: "in_place",
      worktree: "worktree",
    });
  });

  it("names who started a flow run", () => {
    expect(types).toHaveProperty("FlowRunOrigin", {
      user: "user",
      orchestrator: "orchestrator",
    });
  });

  it("names merge outcomes", () => {
    expect(types).toHaveProperty("MergeStatus", {
      merged: "merged",
      conflict: "conflict",
    });
  });

  it("caps parallel flows at three and hands off 16000 characters", () => {
    expect(constants).toMatchObject({
      MAX_PARALLEL_FLOWS: 3,
      DEFAULT_HANDOFF_CHARS: 16_000,
      FLOW_TOOL_SERVER_NAME: "codeweave",
    });
  });
});
