import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DiffOmission, FileChange } from "../../domain/events";
import type { SessionEditsView } from "../../shared/views";

import { EditedFilesPanel } from "./EditedFilesPanel";

afterEach(cleanup);

it("lists_edited_files_and_expands_diff", () => {
  const edits: SessionEditsView = {
    sessionId: "sess-1",
    files: [
      {
        path: "/repo/src/a.ts",
        change: FileChange.modified,
        edits: [
          {
            toolCallId: "tc-1",
            runId: null,
            agent: "orchestrator",
            diff: {
              path: "/repo/src/a.ts",
              change: FileChange.modified,
              patch: "@@ -1,2 +1,2 @@\n-old\n+new\n+extra",
            },
          },
          {
            toolCallId: "tc-2",
            runId: "run-1",
            agent: "reviewer",
            diff: {
              path: "/repo/src/a.ts",
              change: FileChange.modified,
              omitted: DiffOmission.notReported,
            },
          },
        ],
      },
    ],
  };

  render(<EditedFilesPanel edits={edits} cwd="/repo" />);

  expect(screen.getByText("Edited files")).toBeTruthy();
  expect(screen.getByText("src/a.ts")).toBeTruthy();
  expect(screen.getByText("2 edits")).toBeTruthy();
  expect(screen.getByText("+2 −1")).toBeTruthy();
  expect(
    screen.getByText("Edits made through shell commands are not tracked."),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));

  expect(screen.getByText("orchestrator")).toBeTruthy();
  expect(screen.getByText("reviewer")).toBeTruthy();
  expect(screen.getByLabelText("Diff of /repo/src/a.ts")).toBeTruthy();
  expect(screen.getByText("Diff not reported by the provider.")).toBeTruthy();
});

it("panel_shows_not_reported_label_and_empty_state", () => {
  const { rerender } = render(<EditedFilesPanel edits={null} cwd="/repo" />);

  expect(screen.getByText("No edited files yet.")).toBeTruthy();
  expect(
    screen.getByText("Edits made through shell commands are not tracked."),
  ).toBeTruthy();

  rerender(
    <EditedFilesPanel
      cwd="/repo"
      edits={{
        sessionId: "sess-1",
        files: [
          {
            path: "/repo/only.ts",
            change: FileChange.modified,
            edits: [
              {
                toolCallId: "tc-1",
                runId: null,
                agent: "session",
                diff: {
                  path: "/repo/only.ts",
                  change: FileChange.modified,
                  omitted: DiffOmission.notReported,
                },
              },
            ],
          },
        ],
      }}
    />,
  );

  expect(screen.getByText("1 edit")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /only\.ts/ }));
  expect(screen.getByText("Diff not reported by the provider.")).toBeTruthy();
});
