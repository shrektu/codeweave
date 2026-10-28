import { describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { createSettingsService } from "./settingsService";
import { createJsonStore } from "./storage";

async function setup(): Promise<{
  service: ReturnType<typeof createSettingsService>;
  store: ReturnType<typeof createJsonStore>;
  broadcast: ReturnType<typeof vi.fn>;
}> {
  const store = createJsonStore(await makeTempDir());
  const broadcast = vi.fn();
  return {
    service: createSettingsService({ store, broadcast }),
    store,
    broadcast,
  };
}

describe("settings service", () => {
  it("get_returns_defaults_without_the_storage_version", async () => {
    const { service } = await setup();

    expect(await service.get()).toEqual({
      permissionProfile: "bypass",
      effectLevel: "auto",
      claudeExecutable: null,
    });
  });

  it("set_merges_persists_and_broadcasts", async () => {
    const { service, store, broadcast } = await setup();

    const view = await service.set({ permissionProfile: "plan" });

    const expected = {
      permissionProfile: "plan",
      effectLevel: "auto",
      claudeExecutable: null,
    };
    expect(view).toEqual(expected);
    expect(await store.readSettings()).toEqual({ version: 1, ...expected });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "settings/changed",
      expected,
    );
  });

  it("set_null_executable_clears_a_previous_value", async () => {
    const { service } = await setup();
    await service.set({ claudeExecutable: "/opt/claude" });

    const view = await service.set({ claudeExecutable: null });

    expect(view.claudeExecutable).toBeNull();
  });

  it("set_keeps_untouched_fields", async () => {
    const { service } = await setup();
    await service.set({ claudeExecutable: "/opt/claude", effectLevel: "low" });

    const view = await service.set({ permissionProfile: "ask" });

    expect(view).toEqual({
      permissionProfile: "ask",
      effectLevel: "low",
      claudeExecutable: "/opt/claude",
    });
  });

  it("concurrent_sets_do_not_lose_updates", async () => {
    const { service } = await setup();

    await Promise.all([
      service.set({ effectLevel: "full" }),
      service.set({ permissionProfile: "unattended" }),
    ]);

    expect(await service.get()).toEqual({
      permissionProfile: "unattended",
      effectLevel: "full",
      claudeExecutable: null,
    });
  });
});
