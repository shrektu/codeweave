import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { makeTool } from "../../../tests/fakes/fakeIpcClient";

import {
  OUTPUT_PREVIEW_CHARS,
  OUTPUT_PREVIEW_LINES,
  ToolCard,
} from "./ToolCard";

afterEach(cleanup);

it("tool_card_shows_title_kind_status_command_and_output", () => {
  render(
    <ToolCard
      tool={makeTool({
        title: "Run tests",
        kind: "execute",
        status: "completed",
        command: "pnpm test",
        output: "all green",
      })}
    />,
  );

  expect(screen.getByText("Run tests")).toBeTruthy();
  expect(screen.getByText("execute")).toBeTruthy();
  expect(screen.getByText("Done")).toBeTruthy();
  expect(screen.getByText("pnpm test").className).toBe("shell-line");
  expect(screen.getByText("all green").tagName).toBe("PRE");
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

it("execute_command_rendered_as_shell_block", () => {
  const { container } = render(
    <ToolCard
      tool={makeTool({ kind: "execute", title: "Run", command: "git status" })}
    />,
  );

  expect(container.querySelector('[data-variant="shell"]')).not.toBeNull();
  expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Paste into terminal" }),
  ).toBeNull();
});

it("non_execute_command_rendered_as_mono_block", () => {
  render(
    <ToolCard
      tool={makeTool({ kind: "read", title: "Read", command: "src/a.ts" })}
    />,
  );

  expect(screen.getByText("src/a.ts").tagName).toBe("PRE");
  expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
});

it("long_output_collapsed_by_lines", () => {
  const output = Array.from(
    { length: 30 },
    (_, index) => `row ${String(index)}`,
  ).join("\n");
  render(<ToolCard tool={makeTool({ output })} />);

  const shown = document.querySelector(".tool-output")?.textContent ?? "";
  expect(shown.split("\n")).toHaveLength(OUTPUT_PREVIEW_LINES);
  expect(shown).not.toContain("row 12");

  fireEvent.click(screen.getByRole("button", { name: "Show all 30 lines" }));
  expect(document.querySelector(".tool-output")?.textContent).toBe(output);

  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(document.querySelector(".tool-output")?.textContent).toBe(shown);
});

it("tool_card_skips_command_equal_to_title", () => {
  render(<ToolCard tool={makeTool({ title: "ls -la", command: "ls -la" })} />);

  const shown = screen.getAllByText("ls -la");
  expect(shown).toHaveLength(1);
  expect(shown[0]?.tagName).toBe("B");
});

it.each<[Parameters<typeof makeTool>[0], string]>([
  [{ status: "pending" }, "Pending"],
  [{ status: "in_progress" }, "Running"],
  [{ status: "failed" }, "Failed"],
])("tool_card_status_label_%j", (overrides, label) => {
  render(<ToolCard tool={makeTool(overrides)} />);

  expect(screen.getByText(label)).toBeTruthy();
});

it("tool_card_truncates_long_output_with_show_more_toggle", () => {
  const output = `${"a".repeat(OUTPUT_PREVIEW_CHARS)}TAIL`;
  render(<ToolCard tool={makeTool({ output })} />);

  expect(screen.getByText("a".repeat(OUTPUT_PREVIEW_CHARS))).toBeTruthy();
  expect(screen.queryByText(output)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show all 1 lines" }));

  expect(screen.getByText(output)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
});

it("tool_card_does_not_truncate_output_at_the_limit", () => {
  const output = "b".repeat(OUTPUT_PREVIEW_CHARS);
  render(<ToolCard tool={makeTool({ output })} />);

  expect(screen.getByText(output)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});
