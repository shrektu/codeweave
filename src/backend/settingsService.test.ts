import { describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { configuredExecutable, createSettingsService } from "./settingsService";
import { createJsonStore } from "./storage";

async function setup(): Promise<{
  service: ReturnType<typeof createSettingsService>;
  store: ReturnType<typeof createJsonStore>;
  broadcast: ReturnType<typeof vi.fn>;
}> {
  const store = createJsonStore(await makeTempDir());
  const broadcast = vi.fn();
  return {
    service: createSettingsService({
      store,
      broadcast,
      postUpdaterConfig: () => undefined,
    }),
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
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
    });
  });

  it("set_merges_persists_and_broadcasts", async () => {
    const { service, store, broadcast } = await setup();

    const view = await service.set({ permissionProfile: "plan" });

    const expected = {
      permissionProfile: "plan",
      effectLevel: "auto",
      claudeExecutable: null,
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
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

  it("set_codex_executable_is_independent_of_claude_executable", async () => {
    const { service } = await setup();
    await service.set({ claudeExecutable: "/opt/claude" });

    const set = await service.set({ codexExecutable: "/opt/codex" });
    const cleared = await service.set({ codexExecutable: null });

    expect(set.codexExecutable).toBe("/opt/codex");
    expect(set.claudeExecutable).toBe("/opt/claude");
    expect(cleared.codexExecutable).toBeNull();
    expect(cleared.claudeExecutable).toBe("/opt/claude");
  });

  it("set_keeps_untouched_fields", async () => {
    const { service } = await setup();
    await service.set({ claudeExecutable: "/opt/claude", effectLevel: "low" });

    const view = await service.set({ permissionProfile: "ask" });

    expect(view).toEqual({
      permissionProfile: "ask",
      effectLevel: "low",
      claudeExecutable: "/opt/claude",
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
    });
  });

  it("set_opencode_executable_is_independent_of_the_other_executables", async () => {
    const { service, store } = await setup();
    await service.set({
      claudeExecutable: "/opt/claude",
      codexExecutable: "/opt/codex",
    });

    const set = await service.set({ opencodeExecutable: "/opt/opencode" });
    const kept = await service.set({ effectLevel: "low" });
    const cleared = await service.set({ opencodeExecutable: null });

    expect(set).toMatchObject({
      claudeExecutable: "/opt/claude",
      codexExecutable: "/opt/codex",
      opencodeExecutable: "/opt/opencode",
    });
    expect(kept.opencodeExecutable).toBe("/opt/opencode");
    expect(cleared.opencodeExecutable).toBeNull();
    expect((await store.readSettings()).opencodeExecutable).toBeNull();
  });

  it("set_terminal_shell_is_persisted_cleared_and_independent", async () => {
    const { service, store, broadcast } = await setup();
    await service.set({ opencodeExecutable: "/opt/opencode" });

    const set = await service.set({ terminalShell: "/opt/fish" });
    const kept = await service.set({ effectLevel: "low" });
    const stored = (await store.readSettings()).terminalShell;
    const cleared = await service.set({ terminalShell: null });

    expect(set.terminalShell).toBe("/opt/fish");
    expect(set.opencodeExecutable).toBe("/opt/opencode");
    expect(kept.terminalShell).toBe("/opt/fish");
    expect(stored).toBe("/opt/fish");
    expect(cleared.terminalShell).toBeNull();
    expect(broadcast).toHaveBeenLastCalledWith(
      "settings/changed",
      expect.objectContaining({ terminalShell: null }),
    );
  });

  it("set_agy_executable_is_persisted_and_independent_of_the_others", async () => {
    const { service, store } = await setup();
    await service.set({ codexExecutable: "/opt/codex" });

    const set = await service.set({ agyExecutable: "/opt/agy" });
    const kept = await service.set({ effectLevel: "low" });
    const stored = (await store.readSettings()).agyExecutable;
    const cleared = await service.set({ agyExecutable: null });

    expect(set).toMatchObject({
      codexExecutable: "/opt/codex",
      agyExecutable: "/opt/agy",
    });
    expect(kept.agyExecutable).toBe("/opt/agy");
    expect(stored).toBe("/opt/agy");
    expect(cleared.agyExecutable).toBeNull();
    expect(cleared.codexExecutable).toBe("/opt/codex");
  });

  it("agy_executable_belongs_to_the_gemini_provider", async () => {
    const { store, service } = await setup();
    await service.set({ agyExecutable: "/opt/agy" });

    const settings = await store.readSettings();

    expect(configuredExecutable(settings, "gemini")).toBe("/opt/agy");
    expect(configuredExecutable(settings, "codex")).toBeNull();
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
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
    });
  });
});
