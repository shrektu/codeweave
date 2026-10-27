import { describe, expect, it } from "vitest";

import { isAppUrl } from "./appUrl";

const FILE_ENTRY = "file:///opt/codeweave/out/renderer/index.html";
const DEV_ENTRY = "http://localhost:5173/";

describe("is_app_url_rejects_foreign_and_data_urls", () => {
  it.each([
    ["an http url", "http://example.com/", FILE_ENTRY],
    ["an https url", "https://example.com/index.html", FILE_ENTRY],
    ["another file path", "file:///etc/hostname", FILE_ENTRY],
    [
      "the entry path on another file host",
      "file://evil.example/opt/codeweave/out/renderer/index.html",
      FILE_ENTRY,
    ],
    [
      "the entry path on another unc host",
      "file://evil/share/app/index.html",
      "file://corp/share/app/index.html",
    ],
    ["a data url", "data:text/html,<h1>x</h1>", FILE_ENTRY],
    ["about:blank", "about:blank", FILE_ENTRY],
    ["a javascript url", "javascript:void(0)", FILE_ENTRY],
    ["text that is not a url", "not a url", FILE_ENTRY],
    ["the dev host on another port", "http://localhost:5174/", DEV_ENTRY],
    ["another dev host", "http://127.0.0.1:5173/", DEV_ENTRY],
    ["a file url when serving the dev origin", FILE_ENTRY, DEV_ENTRY],
    ["a data url when serving the dev origin", "data:text/html,x", DEV_ENTRY],
  ])("%s", (_label, url, entry) => {
    expect(isAppUrl(url, entry)).toBe(false);
  });
});

describe("is_app_url_accepts_the_app_entry", () => {
  it.each([
    ["the file entry", FILE_ENTRY, FILE_ENTRY],
    ["the file entry with a hash", `${FILE_ENTRY}#top`, FILE_ENTRY],
    ["the dev entry", DEV_ENTRY, DEV_ENTRY],
    [
      "a dev path on the same origin",
      "http://localhost:5173/src/main.tsx",
      DEV_ENTRY,
    ],
  ])("%s", (_label, url, entry) => {
    expect(isAppUrl(url, entry)).toBe(true);
  });
});
