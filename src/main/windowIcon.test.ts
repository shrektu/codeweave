import { join } from "node:path";

import { expect, it } from "vitest";

import { linuxWindowIcon } from "./windowIcon";

it("packaged_icon_comes_from_resources", () => {
  expect(linuxWindowIcon(true, "/opt/Codeweave/resources", "/ignored")).toBe(
    join("/opt/Codeweave/resources", "icon.png"),
  );
});

it("dev_icon_comes_from_build_icons", () => {
  expect(linuxWindowIcon(false, "/ignored", "/work/codeweave")).toBe(
    join("/work/codeweave", "build", "icons", "512x512.png"),
  );
});
