import type { ParamsMap } from "../shared/protocol";
import type { SettingsView } from "../shared/views";

import type { ConnectionRegistry } from "./connections";
import { createSerializer } from "./serialize";
import type { JsonStore, SettingsFile } from "./storage";

export interface SettingsServiceDeps {
  store: JsonStore;
  broadcast: ConnectionRegistry["broadcast"];
}

export interface SettingsService {
  get(): Promise<SettingsView>;
  set(patch: ParamsMap["settings/set"]): Promise<SettingsView>;
}

function toView(settings: SettingsFile): SettingsView {
  return {
    permissionProfile: settings.permissionProfile,
    effectLevel: settings.effectLevel,
    claudeExecutable: settings.claudeExecutable,
  };
}

export function createSettingsService({
  store,
  broadcast,
}: SettingsServiceDeps): SettingsService {
  const serialized = createSerializer();
  return {
    async get(): Promise<SettingsView> {
      return toView(await store.readSettings());
    },
    set: (patch) =>
      serialized(async () => {
        const current = await store.readSettings();
        const next: SettingsFile = {
          ...current,
          permissionProfile:
            patch.permissionProfile ?? current.permissionProfile,
          effectLevel: patch.effectLevel ?? current.effectLevel,
          claudeExecutable:
            patch.claudeExecutable === undefined
              ? current.claudeExecutable
              : patch.claudeExecutable,
        };
        await store.writeSettings(next);
        const view = toView(next);
        broadcast("settings/changed", view);
        return view;
      }),
  };
}
