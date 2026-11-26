import { expect, it } from "vitest";

import type { FileCompletionItem } from "../shared/views";

import { activeMention, applyMention } from "./mentions";

const SRC_FOLDER: FileCompletionItem = { path: "src", kind: "dir" };
const APP_FILE: FileCompletionItem = { path: "src/App.tsx", kind: "file" };
const SPACED_FILE: FileCompletionItem = {
  path: "my file.txt",
  kind: "file",
};
const SPACED_FOLDER: FileCompletionItem = { path: "my dir", kind: "dir" };

it("active_mention_at_index_zero", () => {
  expect(activeMention("@sr", 3)).toEqual({ start: 0, query: "sr" });
});

it("active_mention_needs_a_caret_after_the_marker", () => {
  expect(activeMention("@sr", 0)).toBeNull();
  expect(activeMention("plain", 5)).toBeNull();
});

it("active_mention_after_a_newline", () => {
  expect(activeMention("line\n@src", 10)).toEqual({
    start: 5,
    query: "src",
  });
});

it("active_mention_ignores_marker_inside_a_word", () => {
  expect(activeMention("a@b", 3)).toBeNull();
});

it("active_mention_stops_at_whitespace", () => {
  expect(activeMention("@my fi", 6)).toBeNull();
  expect(activeMention("@src ", 4)).toEqual({ start: 0, query: "src" });
});

it("active_mention_accepts_a_quoted_query", () => {
  expect(activeMention('@"my fi', 7)).toEqual({
    start: 0,
    query: "my fi",
  });
});

it("active_mention_ignores_a_completed_quoted_path", () => {
  expect(activeMention('@"my file.txt" ', 15)).toBeNull();
});

it("active_mention_uses_the_last_marker_before_the_caret", () => {
  expect(activeMention("@one and @two", 13)).toEqual({
    start: 9,
    query: "two",
  });
});

it("apply_mention_replaces_a_folder_with_a_trailing_slash", () => {
  expect(applyMention("@sr", { start: 0, query: "sr" }, SRC_FOLDER)).toEqual({
    text: "@src/",
    caret: 5,
  });
});

it("apply_mention_appends_a_space_after_a_file", () => {
  expect(applyMention("@sr", { start: 0, query: "sr" }, APP_FILE)).toEqual({
    text: "@src/App.tsx ",
    caret: 13,
  });
});

it("apply_mention_quotes_a_path_with_whitespace", () => {
  expect(applyMention("@my", { start: 0, query: "my" }, SPACED_FILE)).toEqual({
    text: '@"my file.txt" ',
    caret: 15,
  });
});

it("apply_mention_quotes_a_folder_with_whitespace", () => {
  expect(applyMention("@my", { start: 0, query: "my" }, SPACED_FOLDER)).toEqual(
    {
      text: '@"my dir"/',
      caret: 10,
    },
  );
});

it("apply_mention_replaces_a_quoted_query_in_place", () => {
  expect(
    applyMention('@"my fi', { start: 0, query: "my fi" }, SPACED_FILE),
  ).toEqual({
    text: '@"my file.txt" ',
    caret: 15,
  });
});

it("apply_mention_keeps_the_text_after_the_token", () => {
  expect(
    applyMention("see @sr now", { start: 4, query: "sr" }, SRC_FOLDER),
  ).toEqual({
    text: "see @src/ now",
    caret: 9,
  });
});
