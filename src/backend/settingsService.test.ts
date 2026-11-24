import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import {
  configuredExecutable,
  createSettingsService,
  withRecentFolder,
} from "./settingsService";
import { createJsonStore } from "./storage";

async function setup(): Promise<{
  service: ReturnType<typeof createSettingsService>;
  store: ReturnType<typeof createJsonStore>;
  broadcast: ReturnType<typeof vi.fn>;
  homeDir: string;
}> {
  const store = createJsonStore(await makeTempDir());
  const homeDir = await makeTempDir();
  const broadcast = vi.fn();
  return {
    service: createSettingsService({
      store,
      broadcast,
      postUpdaterConfig: () => undefined,
      homeDir,
    }),
    store,
    broadcast,
    homeDir,
  };
}

describe("settings service", () => {
  it("get_returns_defaults_without_the_storage_version", async () => {
    const { service, homeDir } = await setup();

    expect(await service.get()).toEqual({
      permissionProfile: "bypass",
      effectLevel: "auto",
      appearance: "system",
      claudeExecutable: null,
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
      defaultTaskClass: "standard",
      definitionLibrary: null,
      defaultWorkspace: null,
      defaultWorkspaceResolved: homeDir,
      recentFolders: [],
    });
  });

  it("set_merges_persists_and_broadcasts", async () => {
    const { service, store, broadcast, homeDir } = await setup();

    const view = await service.set({ permissionProfile: "plan" });

    const expected = {
      permissionProfile: "plan",
      effectLevel: "auto",
      appearance: "system",
      claudeExecutable: null,
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
      defaultTaskClass: "standard",
      definitionLibrary: null,
      defaultWorkspace: null,
      recentFolders: [],
    };
    const expectedView = { ...expected, defaultWorkspaceResolved: homeDir };
    expect(view).toEqual(expectedView);
    expect(await store.readSettings()).toEqual({ version: 1, ...expected });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "settings/changed",
      expectedView,
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
    const { service, homeDir } = await setup();
    await service.set({ claudeExecutable: "/opt/claude", effectLevel: "low" });

    const view = await service.set({ permissionProfile: "ask" });

    expect(view).toEqual({
      permissionProfile: "ask",
      effectLevel: "low",
      appearance: "system",
      claudeExecutable: "/opt/claude",
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
      defaultTaskClass: "standard",
      definitionLibrary: null,
      defaultWorkspace: null,
      defaultWorkspaceResolved: homeDir,
      recentFolders: [],
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

  it("set_rejects_a_relative_flow_library_path", async () => {
    const { service, store } = await setup();

    await expect(
      service.set({ definitionLibrary: "shared/flows" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "The agents and flows library must be an absolute path",
    });

    expect((await store.readSettings()).definitionLibrary).toBeNull();
  });

  it("set_expands_a_leading_tilde_in_the_flow_library_path", async () => {
    const { service, store, homeDir } = await setup();

    const view = await service.set({ definitionLibrary: "~/shared" });
    const alone = await service.set({ definitionLibrary: "~" });
    const backslash = await service.set({ definitionLibrary: "~\\shared" });

    expect(view.definitionLibrary).toBe(join(homeDir, "shared"));
    expect(alone.definitionLibrary).toBe(homeDir);
    expect(backslash.definitionLibrary).toBe(join(homeDir, "shared"));
    expect((await store.readSettings()).definitionLibrary).toBe(
      join(homeDir, "shared"),
    );
  });

  it("set_keeps_an_absolute_flow_library_path_as_given", async () => {
    const { service } = await setup();
    const library = await makeTempDir();

    const view = await service.set({ definitionLibrary: library });

    expect(view.definitionLibrary).toBe(library);
  });

  it("set_blank_flow_library_resets_to_the_default", async () => {
    const { service } = await setup();
    await service.set({ definitionLibrary: await makeTempDir() });

    const blank = await service.set({ definitionLibrary: "  " });
    const stillNull = await service.set({ effectLevel: "low" });

    expect(blank.definitionLibrary).toBeNull();
    expect(stillNull.definitionLibrary).toBeNull();
  });

  it("set_null_flow_library_resets_to_the_default", async () => {
    const { service } = await setup();
    await service.set({ definitionLibrary: await makeTempDir() });

    const view = await service.set({ definitionLibrary: null });

    expect(view.definitionLibrary).toBeNull();
  });

  it("set_does_not_expand_a_tilde_user_path", async () => {
    const { service } = await setup();

    await expect(
      service.set({ definitionLibrary: "~other/shared" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("concurrent_sets_do_not_lose_updates", async () => {
    const { service, homeDir } = await setup();

    await Promise.all([
      service.set({ effectLevel: "full" }),
      service.set({ permissionProfile: "unattended" }),
    ]);

    expect(await service.get()).toEqual({
      permissionProfile: "unattended",
      effectLevel: "full",
      appearance: "system",
      claudeExecutable: null,
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
      defaultTaskClass: "standard",
      definitionLibrary: null,
      defaultWorkspace: null,
      defaultWorkspaceResolved: homeDir,
      recentFolders: [],
    });
  });

  it("recent_folders_are_deduped_newest_first_capped_and_absolute", async () => {
    const { service } = await setup();
    const folders = Array.from(
      { length: 10 },
      (_, index) => `/work/project-${index.toString()}`,
    );

    for (const folder of folders) {
      await service.recordFolder(folder);
    }
    await service.recordFolder("relative/project");
    await service.recordFolder("/work/project-5");
    const view = await service.get();

    expect(view.recentFolders).toEqual(
      [
        "/work/project-5",
        "/work/project-9",
        "/work/project-8",
        "/work/project-7",
        "/work/project-6",
        "/work/project-4",
        "/work/project-3",
        "/work/project-2",
      ].map((folder) => resolve(folder)),
    );
  });

  it("recording_a_folder_broadcasts_and_keeps_other_settings", async () => {
    const { service, broadcast } = await setup();
    await service.set({ effectLevel: "full" });
    broadcast.mockClear();

    await service.recordFolder("/work/app");

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      "settings/changed",
      expect.objectContaining({
        effectLevel: "full",
        recentFolders: [resolve("/work/app")],
      }),
    );
  });

  it("setting_the_flow_library_records_it_as_recent", async () => {
    const { service, homeDir } = await setup();

    const view = await service.set({ definitionLibrary: "~/shared" });

    expect(view.recentFolders).toEqual([join(homeDir, "shared")]);
  });

  it("recent_folder_repeat_use_does_not_rewrite_settings", async () => {
    const { service, store, broadcast } = await setup();
    const writes = vi.spyOn(store, "writeSettings");

    await service.recordFolder("/work/app");
    await service.recordFolder("/work/app");

    expect((await service.get()).recentFolders).toEqual([resolve("/work/app")]);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("recent_folder_trailing_separator_deduped", async () => {
    const { service } = await setup();

    await service.recordFolder("/a/proj/");
    await service.recordFolder("/a/proj");

    expect((await service.get()).recentFolders).toEqual([resolve("/a/proj")]);
  });

  it("recent_folder_windows_case_deduped", () => {
    const first = withRecentFolder([], "C:\\x", "win32");
    const second = withRecentFolder(first, "c:\\x", "win32");
    const third = withRecentFolder(second, "C:/x", "win32");

    expect(first).toEqual(["C:\\x"]);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
