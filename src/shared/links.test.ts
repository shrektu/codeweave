import { expect, it } from "vitest";

import { isWebUrl } from "./links";

it.each([
  ["https://example.com", true],
  ["http://example.com/a?b=1#c", true],
  ["HTTPS://EXAMPLE.COM", true],
  ["javascript:alert(1)", false],
  ["file:///etc/passwd", false],
  ["data:text/html,x", false],
  ["mailto:a@b.c", false],
  ["ftp://example.com", false],
  ["//example.com", false],
  ["./relative.md", false],
  ["", false],
  ["https://", false],
])("is_web_url_cases %s", (value, expected) => {
  expect(isWebUrl(value)).toBe(expected);
});
