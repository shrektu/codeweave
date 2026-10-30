import { describe, expect, it } from "vitest";

import { PermissionProfile } from "../../domain/types";

import { agySettingsFor } from "./permissions";

function denyOf(profile: PermissionProfile): readonly string[] {
  return agySettingsFor(profile).settings.permissions?.deny ?? [];
}

describe("agy permission settings", () => {
  it("bypass_proceeds_without_rules_or_mode", () => {
    expect(agySettingsFor(PermissionProfile.bypass)).toEqual({
      settings: { toolPermission: "always-proceed", useG1Credits: false },
      mode: null,
    });
  });

  it("unattended_proceeds_but_denies_danger_and_opaque_commands", () => {
    const deny = denyOf(PermissionProfile.unattended);

    expect(agySettingsFor(PermissionProfile.unattended).settings).toMatchObject(
      { toolPermission: "always-proceed", useG1Credits: false },
    );
    expect(deny).toEqual(
      expect.arrayContaining([
        "command(sudo)",
        "command(eval)",
        "command(systemd-run)",
        "command(rm -rf)",
        "command(git push origin main)",
      ]),
    );
  });

  it("accept_edits_reviews_commands_and_selects_accept_edits_mode", () => {
    const launch = agySettingsFor(PermissionProfile.acceptEdits);

    expect(launch.mode).toBe("accept-edits");
    expect(launch.settings.toolPermission).toBe("request-review");
    expect(launch.settings.permissions?.deny).not.toContain("write_file(*)");
    expect(launch.settings.permissions?.deny).not.toContain("command(eval)");
  });

  it("ask_and_plan_deny_file_writes_and_plan_selects_plan_mode", () => {
    expect(agySettingsFor(PermissionProfile.ask).mode).toBeNull();
    expect(agySettingsFor(PermissionProfile.plan).mode).toBe("plan");
    expect(denyOf(PermissionProfile.ask)).toContain("write_file(*)");
    expect(denyOf(PermissionProfile.plan)).toContain("write_file(*)");
  });

  it("migration_commands_are_denied_with_their_full_prefix", () => {
    expect(denyOf(PermissionProfile.ask)).toEqual(
      expect.arrayContaining([
        "command(liquibase update)",
        "command(prisma migrate deploy)",
        "command(knex migrate:latest)",
      ]),
    );
  });

  it("no_profile_carries_an_allow_list", () => {
    for (const profile of Object.values(PermissionProfile)) {
      const permissions = agySettingsFor(profile).settings.permissions;

      expect(permissions === undefined || !("allow" in permissions)).toBe(true);
    }
  });

  it("every_profile_forces_g1_credits_off", () => {
    for (const profile of Object.values(PermissionProfile)) {
      expect(agySettingsFor(profile).settings.useG1Credits).toBe(false);
    }
  });
});
