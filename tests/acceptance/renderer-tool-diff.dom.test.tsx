import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ToolCard } from "../../src/renderer/components/ToolCard";
import { makeTool } from "../fakes/fakeIpcClient";

afterEach(cleanup);

const MODIFIED_PATCH = [
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " export { a, b };",
].join("\n");

const CREATED_PATCH = ["@@ -0,0 +1,2 @@", "+first", "+second"].join("\n");

const DELETED_PATCH = ["@@ -1,2 +0,0 @@", "-first", "-second"].join("\n");

const LONG_LINE_COUNT = 60;
const PREVIEW_LINES = 40;

function longPatch(): string {
  const body = Array.from(
    { length: LONG_LINE_COUNT - 1 },
    (_, index) => `+line ${String(index)}`,
  );
  return [`@@ -0,0 +1,${String(body.length)} @@`, ...body].join("\n");
}

it("modified_diff_renders_added_and_removed_lines", () => {
  render(
    <ToolCard
      tool={makeTool({
        diffs: [
          { path: "src/app.ts", change: "modified", patch: MODIFIED_PATCH },
        ],
      })}
    />,
  );

  const block = screen.getByLabelText("Diff of src/app.ts");
  expect(block.tagName).toBe("PRE");
  expect(screen.getByText("src/app.ts").tagName).toBe("B");
  expect(screen.getByText("Modified")).toBeTruthy();
  expect(screen.getByText("+const b = 3;").dataset.kind).toBe("add");
  expect(screen.getByText("-const b = 2;").dataset.kind).toBe("del");
  expect(screen.getByText("@@ -1,3 +1,3 @@").dataset.kind).toBe("hunk");
  expect(screen.getByText("const a = 1;", { exact: false }).dataset.kind).toBe(
    "ctx",
  );
});

it("created_and_deleted_diffs_show_change_label", () => {
  render(
    <ToolCard
      tool={makeTool({
        diffs: [
          { path: "new.txt", change: "created", patch: CREATED_PATCH },
          { path: "old.txt", change: "deleted", patch: DELETED_PATCH },
        ],
      })}
    />,
  );

  expect(screen.getByText("Created")).toBeTruthy();
  expect(screen.getByText("Deleted")).toBeTruthy();
  expect(screen.getByLabelText("Diff of new.txt")).toBeTruthy();
  expect(screen.getByLabelText("Diff of old.txt")).toBeTruthy();
});

it("binary_diff_shows_omission_message", () => {
  render(
    <ToolCard
      tool={makeTool({
        diffs: [{ path: "logo.png", change: "modified", omitted: "binary" }],
      })}
    />,
  );

  expect(screen.getByText("Diff not shown: binary file.")).toBeTruthy();
  expect(screen.queryByLabelText("Diff of logo.png")).toBeNull();
});

it("too_large_diff_shows_omission_message", () => {
  render(
    <ToolCard
      tool={makeTool({
        diffs: [{ path: "dump.sql", change: "created", omitted: "too_large" }],
      })}
    />,
  );

  expect(screen.getByText("Diff not shown: file too large.")).toBeTruthy();
  expect(screen.queryByLabelText("Diff of dump.sql")).toBeNull();
});

it("long_diff_collapses_to_preview_with_show_more", () => {
  render(
    <ToolCard
      tool={makeTool({
        diffs: [{ path: "big.ts", change: "created", patch: longPatch() }],
      })}
    />,
  );
  const lineCount = (): number =>
    screen.getByLabelText("Diff of big.ts").querySelectorAll(".diff-line")
      .length;

  expect(lineCount()).toBe(PREVIEW_LINES);

  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(lineCount()).toBe(LONG_LINE_COUNT);

  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(lineCount()).toBe(PREVIEW_LINES);
});

it("empty_created_file_renders_no_diff_lines", () => {
  const { container } = render(
    <ToolCard
      tool={makeTool({
        diffs: [{ path: "empty.txt", change: "created", patch: "" }],
      })}
    />,
  );

  expect(screen.getByText("empty.txt")).toBeTruthy();
  expect(screen.getByText("Created")).toBeTruthy();
  expect(screen.queryByLabelText("Diff of empty.txt")).toBeNull();
  expect(container.querySelectorAll(".diff-line")).toHaveLength(0);
});

it("two_diffs_of_same_path_keep_separate_state", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { container } = render(
    <ToolCard
      tool={makeTool({
        diffs: [
          { path: "big.ts", change: "created", patch: longPatch() },
          { path: "big.ts", change: "modified", patch: longPatch() },
        ],
      })}
    />,
  );
  const lineCounts = (): number[] =>
    Array.from(container.querySelectorAll(".diff")).map(
      (block) => block.querySelectorAll(".diff-line").length,
    );

  const [firstButton] = screen.getAllByRole("button", { name: "Show more" });
  if (firstButton === undefined) {
    throw new Error("expected a Show more button");
  }
  fireEvent.click(firstButton);

  expect(lineCounts()).toEqual([LONG_LINE_COUNT, PREVIEW_LINES]);
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

it("tool_without_diffs_renders_unchanged", () => {
  const { container } = render(
    <ToolCard tool={makeTool({ status: "completed", output: "all green" })} />,
  );

  expect(container.querySelector(".diff")).toBeNull();
  expect(container.querySelector(".diff-omitted")).toBeNull();
  expect(container.querySelectorAll("pre")).toHaveLength(1);
  expect(screen.queryByRole("button")).toBeNull();
});
