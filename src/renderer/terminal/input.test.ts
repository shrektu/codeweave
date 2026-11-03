import { expect, it } from "vitest";

import { splitInput } from "./input";

const MAX = 4;

it("split_input_returns_nothing_for_empty_data", () => {
  expect(splitInput("", MAX)).toEqual([]);
});

it("split_input_keeps_data_of_exactly_max_in_one_chunk", () => {
  expect(splitInput("abcd", MAX)).toEqual(["abcd"]);
});

it("split_input_splits_data_one_over_max", () => {
  expect(splitInput("abcde", MAX)).toEqual(["abcd", "e"]);
});

it("split_input_never_cuts_a_surrogate_pair", () => {
  expect(splitInput("abc😀d", MAX)).toEqual(["abc", "😀d"]);
});

it("split_input_keeps_a_pair_that_ends_exactly_on_the_boundary", () => {
  expect(splitInput("ab😀cd", MAX)).toEqual(["ab😀", "cd"]);
});

it("split_input_makes_progress_when_max_is_one", () => {
  expect(splitInput("a😀", 1)).toEqual(["a", "\ud83d", "\ude00"]);
});

it("paste_larger_than_input_limit_is_split_by_default_limit", () => {
  const chunks = splitInput("x".repeat(131_072 + 1));

  expect(chunks.map((chunk) => chunk.length)).toEqual([65_536, 65_536, 1]);
});
