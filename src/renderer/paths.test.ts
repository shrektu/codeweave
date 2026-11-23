import { expect, it } from "vitest";

import { displayPath, splitPath } from "./paths";

it("display_path_posix_home_becomes_tilde", () => {
  expect(displayPath("/home/seb/projects/app", "/home/seb", "linux")).toBe(
    "~/projects/app",
  );
});

it("display_path_outside_home_is_unchanged", () => {
  expect(displayPath("/srv/data", "/home/seb", "linux")).toBe("/srv/data");
});

it("display_path_sibling_with_home_as_prefix_is_unchanged", () => {
  expect(displayPath("/home/sebastian/app", "/home/seb", "linux")).toBe(
    "/home/sebastian/app",
  );
});

it("display_path_windows_drive", () => {
  expect(displayPath("C:\\Users\\x\\proj", "C:\\Users\\x", "win32")).toBe(
    "~\\proj",
  );
});

it("display_path_windows_home_match_ignores_case", () => {
  expect(displayPath("c:\\users\\x\\proj", "C:\\Users\\X", "win32")).toBe(
    "~\\proj",
  );
});

it("display_path_equal_to_home_is_tilde", () => {
  expect(displayPath("/home/seb", "/home/seb", "linux")).toBe("~");
});

it("display_path_home_trailing_separator", () => {
  expect(displayPath("/home/seb/proj", "/home/seb/", "linux")).toBe("~/proj");
  expect(displayPath("C:\\Users\\x\\proj", "C:\\Users\\x\\", "win32")).toBe(
    "~\\proj",
  );
});

it("display_path_null_home_leaves_path", () => {
  expect(displayPath("/home/seb/proj", null, "linux")).toBe("/home/seb/proj");
});

it("display_path_root_home_is_not_abbreviated", () => {
  expect(displayPath("/etc/hosts", "/", "linux")).toBe("/etc/hosts");
});

it("split_path_puts_the_last_segment_in_the_tail", () => {
  expect(splitPath("~/work/deep/project", "linux")).toEqual({
    head: "~/work/deep",
    tail: "/project",
  });
});

it("split_path_ignores_a_trailing_separator", () => {
  expect(splitPath("/srv/data/", "linux")).toEqual({
    head: "/srv",
    tail: "/data",
  });
});

it("split_path_without_separator_is_all_tail", () => {
  expect(splitPath("~", "linux")).toEqual({ head: "", tail: "~" });
});

it("split_path_windows_uses_backslash_segments", () => {
  expect(splitPath("C:\\Users\\x\\proj", "win32")).toEqual({
    head: "C:\\Users\\x",
    tail: "\\proj",
  });
});
