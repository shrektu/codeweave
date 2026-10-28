import { expect, it } from "vitest";

import { resolveUserDataOverride } from "./userDataOverride";

const OVERRIDE_DIR = "/tmp/codeweave-e2e";

it("resolve_user_data_override_returns_dir_when_not_packaged", () => {
  expect(
    resolveUserDataOverride({
      isPackaged: false,
      env: { CODEWEAVE_USER_DATA_DIR: OVERRIDE_DIR },
    }),
  ).toBe(OVERRIDE_DIR);
});

it("resolve_user_data_override_ignores_env_when_packaged", () => {
  expect(
    resolveUserDataOverride({
      isPackaged: true,
      env: { CODEWEAVE_USER_DATA_DIR: OVERRIDE_DIR },
    }),
  ).toBeNull();
});

it("resolve_user_data_override_returns_null_when_unset_or_empty", () => {
  expect(resolveUserDataOverride({ isPackaged: false, env: {} })).toBeNull();
  expect(
    resolveUserDataOverride({
      isPackaged: false,
      env: { CODEWEAVE_USER_DATA_DIR: "" },
    }),
  ).toBeNull();
});
