import { expect, it, vi } from "vitest";

import { createFakeIpcClient } from "../../tests/fakes/fakeIpcClient";
import { DefinitionSource, SlashCommandKind } from "../domain/types";
import type { SlashCommandView } from "../shared/views";

import {
  activeSlashQuery,
  expandSlashCommand,
  matchSlashItems,
  parseSlashInput,
  resolvePromptText,
  resolveSlashText,
} from "./slashCommands";

const REVIEW: SlashCommandView = {
  name: "review",
  description: "Review changed files",
  kind: SlashCommandKind.prompt,
  source: DefinitionSource.project,
  file: "prompts/review.md",
  body: "Review $ARGUMENTS",
};

it("active_slash_query_reads_the_first_token", () => {
  expect(activeSlashQuery("/re", 3)).toBe("re");
  expect(activeSlashQuery("/", 1)).toBe("");
  expect(activeSlashQuery("/re", 2)).toBe("r");
});

it("leading_whitespace_does_not_open_the_menu", () => {
  expect(activeSlashQuery(" /re", 4)).toBeNull();
});

it("caret_at_the_start_opens_nothing", () => {
  expect(activeSlashQuery("/re", 0)).toBeNull();
});

it("caret_after_the_first_space_closes_the_command_list", () => {
  expect(activeSlashQuery("/re done", 7)).toBeNull();
});

it("caret_before_the_first_space_still_opens_the_list", () => {
  expect(activeSlashQuery("/re done", 3)).toBe("re");
});

it("parse_slash_input_splits_name_and_trimmed_arguments", () => {
  expect(parseSlashInput("/review src/a.ts")).toEqual({
    name: "review",
    args: "src/a.ts",
  });
  expect(parseSlashInput("/review")).toEqual({ name: "review", args: "" });
  expect(parseSlashInput("/review   ")).toEqual({ name: "review", args: "" });
  expect(parseSlashInput("/")).toBeNull();
  expect(parseSlashInput("/ review")).toBeNull();
  expect(parseSlashInput("review")).toBeNull();
});

it("arguments_placeholder_is_replaced_everywhere", () => {
  expect(expandSlashCommand("A $ARGUMENTS B $ARGUMENTS", "x")).toBe("A x B x");
});

it("empty_arguments_leave_the_body_unchanged", () => {
  expect(expandSlashCommand("Plain body", "")).toBe("Plain body");
});

it("arguments_without_a_placeholder_are_appended_after_a_blank_line", () => {
  expect(expandSlashCommand("Plain body", "x")).toBe("Plain body\n\nx");
});

it("prefix_matches_come_before_substring_matches", () => {
  const items = [{ name: "review" }, { name: "preview" }, { name: "reviewer" }];

  expect(matchSlashItems("re", items).map((item) => item.name)).toEqual([
    "review",
    "reviewer",
    "preview",
  ]);
});

it("matching_is_case_insensitive", () => {
  expect(matchSlashItems("RE", [{ name: "Review" }])).toEqual([
    { name: "Review" },
  ]);
});

it("resolve_slash_text_expands_a_known_command", () => {
  expect(resolveSlashText("/review src/a.ts", [REVIEW])).toBe(
    "Review src/a.ts",
  );
});

it("resolve_slash_text_keeps_unknown_and_plain_text", () => {
  expect(resolveSlashText("/other src/a.ts", [REVIEW])).toBe("/other src/a.ts");
  expect(resolveSlashText("plain text", [REVIEW])).toBe("plain text");
});

it("send_resolves_with_fresh_commands_when_the_menu_never_opened", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", { commands: [REVIEW], errors: [] });

  expect(await resolvePromptText(client, "/repo", "/review src/a.ts")).toBe(
    "Review src/a.ts",
  );
  expect(client.requests).toEqual([
    { method: "commands/list", params: { cwd: "/repo" } },
  ]);
});

it("resolve_prompt_text_keeps_the_text_when_the_lookup_fails", async () => {
  const client = createFakeIpcClient();
  client.fail("commands/list", new Error("boom"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await resolvePromptText(client, undefined, "/review src/a.ts")).toBe(
    "/review src/a.ts",
  );
  expect(client.requests).toEqual([{ method: "commands/list", params: {} }]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("plain_text_is_sent_without_a_lookup", async () => {
  const client = createFakeIpcClient();

  expect(await resolvePromptText(client, "/repo", "plain text")).toBe(
    "plain text",
  );
  expect(client.requests).toEqual([]);
});
