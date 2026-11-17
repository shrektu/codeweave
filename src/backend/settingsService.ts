import { ProviderId } from "../domain/types";
import type { ParamsMap } from "../shared/protocol";
import { UPDATER_CONFIG_MESSAGE_TYPE } from "../shared/constants";
import type { UpdaterConfigMessage } from "../shared/updates";
import type { SettingsView } from "../shared/views";

import type { ConnectionRegistry } from "./connections";
import { createSerializer } from "./serialize";
import type { JsonStore, SettingsFile } from "./storage";

export interface SettingsServiceDeps {
  store: JsonStore;
  broadcast: ConnectionRegistry["broadcast"];
  postUpdaterConfig: PostUpdaterConfig;
}

export type PostUpdaterConfig = (message: UpdaterConfigMessage) => void;

export interface SettingsService {
  get(): Promise<SettingsView>;
  set(patch: ParamsMap["settings/set"]): Promise<SettingsView>;
}

type ExecutableSetting = keyof Pick<
  SettingsFile,
  | "claudeExecutable"
  | "codexExecutable"
  | "agyExecutable"
  | "opencodeExecutable"
>;

const EXECUTABLE_SETTINGS: Readonly<
  Partial<Record<ProviderId, ExecutableSetting>>
> = {
  [ProviderId.claude]: "claudeExecutable",
  [ProviderId.codex]: "codexExecutable",
  [ProviderId.gemini]: "agyExecutable",
  [ProviderId.opencode]: "opencodeExecutable",
};

export function configuredExecutable(
  settings: SettingsFile,
  provider: ProviderId,
): string | null {
  const field = EXECUTABLE_SETTINGS[provider];
  return field === undefined ? null : settings[field];
}

function toView(settings: SettingsFile): SettingsView {
  return {
    permissionProfile: settings.permissionProfile,
    effectLevel: settings.effectLevel,
    claudeExecutable: settings.claudeExecutable,
    codexExecutable: settings.codexExecutable,
    agyExecutable: settings.agyExecutable,
    opencodeExecutable: settings.opencodeExecutable,
    terminalShell: settings.terminalShell,
    updateCheck: settings.updateCheck,
    updateChannel: settings.updateChannel,
    defaultTaskClass: settings.defaultTaskClass,
  };
}

export function toUpdaterConfigMessage(
  settings: SettingsFile,
): UpdaterConfigMessage {
  return {
    type: UPDATER_CONFIG_MESSAGE_TYPE,
    enabled: settings.updateCheck,
    channel: settings.updateChannel,
  };
}

export function createSettingsService({
  store,
  broadcast,
  postUpdaterConfig,
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
          codexExecutable:
            patch.codexExecutable === undefined
              ? current.codexExecutable
              : patch.codexExecutable,
          agyExecutable:
            patch.agyExecutable === undefined
              ? current.agyExecutable
              : patch.agyExecutable,
          opencodeExecutable:
            patch.opencodeExecutable === undefined
              ? current.opencodeExecutable
              : patch.opencodeExecutable,
          terminalShell:
            patch.terminalShell === undefined
              ? current.terminalShell
              : patch.terminalShell,
          updateCheck: patch.updateCheck ?? current.updateCheck,
          updateChannel: patch.updateChannel ?? current.updateChannel,
          defaultTaskClass: patch.defaultTaskClass ?? current.defaultTaskClass,
        };
        await store.writeSettings(next);
        const view = toView(next);
        broadcast("settings/changed", view);
        postUpdaterConfig(toUpdaterConfigMessage(next));
        return view;
      }),
  };
}
