import { expect, it, vi } from "vitest";

import { DiffOmission, FileChange } from "../domain/events";
import { PermissionProfile, ProviderId } from "../domain/types";
import type {
  SessionEditsView,
  SessionView,
  ToolCallView,
} from "../shared/views";

import { createEditedFilesTracker } from "./editedFiles";

function makeToolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "tc-1",
    title: "Edit file",
    kind: "edit",
    status: "completed",
    seq: 1,
    ...overrides,
  };
}

function makeView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "sess-1",
    createdAt: 0,
    cwd: "/repo",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.acceptEdits,
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    activeProvider: ProviderId.claude,
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    contextUsage: null,
    turns: [],
    orchestrate: false,
    prompts: [],
    ...overrides,
  };
}

const MAIN_DIFF = {
  path: "/repo/a.ts",
  change: FileChange.modified,
  patch: "@@ -1,1 +1,1 @@\n-a\n+b",
};
const RUN_A_DIFF = {
  path: "/repo/a.ts",
  change: FileChange.modified,
  omitted: DiffOmission.notReported,
};
const RUN_B_DIFF = {
  path: "/repo/b.ts",
  change: FileChange.created,
  patch: "@@ -0,0 +1,1 @@\n+new",
};

const EXPECTED_COLLECTED: readonly SessionEditsView[] = [
  {
    sessionId: "sess-1",
    files: [
      {
        path: "/repo/a.ts",
        change: FileChange.modified,
        edits: [
          {
            toolCallId: "tc-main",
            runId: null,
            agent: "orchestrator",
            diff: MAIN_DIFF,
          },
          {
            toolCallId: "tc-run",
            runId: "run-1",
            agent: "implementer",
            diff: RUN_A_DIFF,
          },
        ],
      },
      {
        path: "/repo/b.ts",
        change: FileChange.created,
        edits: [
          {
            toolCallId: "tc-run",
            runId: "run-1",
            agent: "implementer",
            diff: RUN_B_DIFF,
          },
        ],
      },
    ],
  },
];

it("collects_completed_edits_of_session_and_owned_runs", () => {
  const published: SessionEditsView[] = [];
  const publish = vi.fn((edits: SessionEditsView) => {
    published.push(edits);
  });
  const tracker = createEditedFilesTracker({
    ownerOf: (runId) => (runId === "run-1" ? "sess-1" : null),
    publish,
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      orchestrate: true,
      toolCalls: [makeToolCall({ toolCallId: "tc-main", diffs: [MAIN_DIFF] })],
    }),
  );
  tracker.observeRun(
    "run-1",
    makeView({
      id: "run-sess-1",
      flowRef: { flowId: "flow-1", nodeId: "implementer" },
      toolCalls: [
        makeToolCall({ toolCallId: "tc-run", diffs: [RUN_A_DIFF, RUN_B_DIFF] }),
      ],
    }),
  );

  expect(tracker.views()).toEqual(EXPECTED_COLLECTED);
  expect(published).toHaveLength(2);
});

it("ignores_failed_and_pending_tool_calls", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-pending",
          status: "pending",
          diffs: [
            {
              path: "/repo/p.ts",
              change: FileChange.modified,
              patch: "@@ -1,1 +1,1 @@\n-a\n+b",
            },
          ],
        }),
        makeToolCall({
          toolCallId: "tc-failed",
          status: "failed",
          diffs: [
            {
              path: "/repo/f.ts",
              change: FileChange.modified,
              patch: "@@ -1,1 +1,1 @@\n-a\n+b",
            },
          ],
        }),
      ],
    }),
  );

  expect(tracker.views()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

it("ignores_runs_without_owner", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });

  tracker.observeRun(
    "run-orphan",
    makeView({
      id: "run-sess",
      toolCalls: [
        makeToolCall({
          diffs: [
            {
              path: "/repo/a.ts",
              change: FileChange.modified,
              omitted: DiffOmission.notReported,
            },
          ],
        }),
      ],
    }),
  );

  expect(tracker.views()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

it("repeated_observation_does_not_duplicate", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });
  const view = makeView({
    id: "sess-1",
    toolCalls: [
      makeToolCall({
        toolCallId: "tc-1",
        diffs: [
          {
            path: "/repo/a.ts",
            change: FileChange.modified,
            patch: "@@ -1,1 +1,1 @@\n-a\n+b",
          },
        ],
      }),
    ],
  });

  tracker.observeMain(view);
  tracker.observeMain(view);

  expect(tracker.views()[0]?.files[0]?.edits).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("replaced_diff_replaces_edit", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          diffs: [
            {
              path: "/repo/a.ts",
              change: FileChange.modified,
              patch: "@@ -1,1 +1,1 @@\n-a\n+b",
            },
          ],
        }),
      ],
    }),
  );
  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          diffs: [
            {
              path: "/repo/a.ts",
              change: FileChange.modified,
              patch: "@@ -1,1 +1,1 @@\n-a\n+c",
            },
          ],
        }),
      ],
    }),
  );

  const edits = tracker.views()[0]?.files[0]?.edits ?? [];
  expect(edits).toHaveLength(1);
  expect(edits[0]?.diff).toEqual({
    path: "/repo/a.ts",
    change: FileChange.modified,
    patch: "@@ -1,1 +1,1 @@\n-a\n+c",
  });
  expect(publish).toHaveBeenCalledTimes(2);
});

it("released_run_keeps_edits", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: (runId) => (runId === "run-1" ? "sess-1" : null),
    publish,
  });

  tracker.observeRun(
    "run-1",
    makeView({
      id: "run-sess",
      flowRef: { flowId: "f", nodeId: "coder" },
      toolCalls: [
        makeToolCall({
          diffs: [
            {
              path: "/repo/a.ts",
              change: FileChange.created,
              patch: "@@ -0,0 +1,1 @@\n+x",
            },
          ],
        }),
      ],
    }),
  );
  tracker.observeRun("run-1", null);
  tracker.observeMain(null);

  expect(tracker.views()).toHaveLength(1);
  expect(tracker.views()[0]?.files).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("publishes_only_on_change", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });

  tracker.observeMain(makeView({ id: "sess-1", toolCalls: [] }));
  expect(publish).not.toHaveBeenCalled();

  const viewWithEdit = makeView({
    id: "sess-1",
    toolCalls: [
      makeToolCall({
        diffs: [
          {
            path: "/repo/a.ts",
            change: FileChange.modified,
            omitted: DiffOmission.notReported,
          },
        ],
      }),
    ],
  });
  tracker.observeMain(viewWithEdit);
  tracker.observeMain(viewWithEdit);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("net_change_created_then_deleted_is_deleted", () => {
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish: () => undefined,
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          diffs: [
            {
              path: "/repo/temp.ts",
              change: FileChange.created,
              patch: "@@ -0,0 +1,1 @@\n+x",
            },
          ],
        }),
        makeToolCall({
          toolCallId: "tc-2",
          diffs: [
            {
              path: "/repo/temp.ts",
              change: FileChange.deleted,
              patch: "@@ -1,1 +0,0 @@\n-x",
            },
          ],
        }),
      ],
    }),
  );

  expect(tracker.views()[0]?.files[0]?.change).toBe(FileChange.deleted);
});

const SHRINK_BEFORE = [
  {
    path: "/repo/a.ts",
    change: FileChange.modified,
    patch: "@@ -1 +1 @@\n-1\n+a",
  },
  {
    path: "/repo/b.ts",
    change: FileChange.modified,
    patch: "@@ -1 +1 @@\n-2\n+b",
  },
  {
    path: "/repo/c.ts",
    change: FileChange.modified,
    patch: "@@ -1 +1 @@\n-3\n+c",
  },
];
const SHRINK_AFTER_DIFF = {
  path: "/repo/a.ts",
  change: FileChange.modified,
  patch: "@@ -1 +1 @@\n-1\n+x",
};
const SHRINK_AFTER = [SHRINK_AFTER_DIFF];

it("tracker_drops_stale_edits_when_diffs_shrink", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [makeToolCall({ toolCallId: "tc-1", diffs: SHRINK_BEFORE })],
    }),
  );
  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [makeToolCall({ toolCallId: "tc-1", diffs: SHRINK_AFTER })],
    }),
  );

  expect(tracker.views()).toEqual([
    {
      sessionId: "sess-1",
      files: [
        {
          path: "/repo/a.ts",
          change: FileChange.modified,
          edits: [
            {
              toolCallId: "tc-1",
              runId: null,
              agent: "session",
              diff: SHRINK_AFTER_DIFF,
            },
          ],
        },
      ],
    },
  ]);
  expect(publish).toHaveBeenCalledTimes(2);
});

it("tracker_removes_file_when_diffs_become_empty", () => {
  const published: SessionEditsView[] = [];
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish: (edits) => {
      published.push(edits);
    },
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [makeToolCall({ toolCallId: "tc-1", diffs: [MAIN_DIFF] })],
    }),
  );
  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [makeToolCall({ toolCallId: "tc-1", diffs: [] })],
    }),
  );

  expect(tracker.views()).toEqual([]);
  expect(published).toEqual([
    {
      sessionId: "sess-1",
      files: [
        {
          path: "/repo/a.ts",
          change: FileChange.modified,
          edits: [
            {
              toolCallId: "tc-1",
              runId: null,
              agent: "session",
              diff: MAIN_DIFF,
            },
          ],
        },
      ],
    },
    { sessionId: "sess-1", files: [] },
  ]);
});

it("forget_drops_entries_without_publishing", () => {
  const publish = vi.fn();
  const tracker = createEditedFilesTracker({
    ownerOf: () => null,
    publish,
  });

  tracker.observeMain(
    makeView({
      id: "sess-1",
      toolCalls: [makeToolCall({ toolCallId: "tc-1", diffs: [MAIN_DIFF] })],
    }),
  );
  publish.mockClear();

  tracker.forget("sess-1");

  expect(tracker.views()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});
