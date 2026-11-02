import { describe, expect, it } from "vitest";

import { PermissionProfile } from "../../domain/types";

import { agySettingsFor } from "./permissions";

describe("agy permission settings", () => {
  it("every_profile_proceeds_without_rules_and_blocks_g1_credits", () => {
    for (const profile of Object.values(PermissionProfile)) {
      expect(agySettingsFor(profile).settings).toEqual({
        toolPermission: "always-proceed",
        useG1Credits: false,
      });
    }
  });

  it("only_plan_selects_a_mode", () => {
    const modes = Object.values(PermissionProfile).map((profile) => [
      profile,
      agySettingsFor(profile).mode,
    ]);

    expect(modes).toEqual([
      ["bypass", null],
      ["unattended", null],
      ["accept-edits", null],
      ["ask", null],
      ["plan", "plan"],
    ]);
  });
});
