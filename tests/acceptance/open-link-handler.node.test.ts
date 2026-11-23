import { expect, it, vi } from "vitest";

import { externalLinkOf, openFromApp } from "../../src/main/externalLink";

it.each([
  ["https url", "https://example.com/a?b=1", "https://example.com/a?b=1"],
  ["http url", "http://example.com", "http://example.com/"],
])("open_link_handler_accepts_%s", (_label, value, expected) => {
  expect(externalLinkOf(value)).toBe(expected);
});

it.each([
  ["javascript", "javascript:alert(1)"],
  ["file", "file:///etc/passwd"],
  ["data", "data:text/html,x"],
  ["mailto", "mailto:a@b.c"],
  ["relative", "./readme.md"],
  ["empty", ""],
  ["number", 5],
  ["null", null],
  ["object", { href: "https://example.com" }],
])("open_link_handler_rejects_non_web_value_%s", (_label, value) => {
  expect(externalLinkOf(value)).toBeNull();
});

it("open_link_handler_rejects_non_web_and_foreign_sender", async () => {
  const open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue();

  await openFromApp(false, "https://example.com", open);
  await openFromApp(true, "javascript:alert(1)", open);
  await openFromApp(true, undefined, open);
  expect(open).not.toHaveBeenCalled();

  await openFromApp(true, "https://example.com/ok", open);
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/ok");
});
