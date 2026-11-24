import { isAbsolute, join } from "node:path";

import { ProviderId } from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
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
  homeDir: string;
}

const HOME_MARKER = "~";
const HOME_PREFIXES = ["~/", "~\\"] as const;
const RELATIVE_LIBRARY_MESSAGE =
  "The flow library folder must be an absolute path";
const RELATIVE_WORKSPACE_MESSAGE =
  "The default workspace must be an absolute path";

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

function expandHome(path: string, homeDir: string): string {
  if (path === HOME_MARKER) {
    return homeDir;
  }
  return HOME_PREFIXES.some((prefix) => path.startsWith(prefix))
    ? join(homeDir, path.slice(HOME_MARKER.length + 1))
    : path;
}

function folderSetting(
  value: string | null | undefined,
  current: string | null,
  homeDir: string,
  relativeMessage: string,
): string | null {
  if (value === undefined) {
    return current;
  }
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  const expanded = expandHome(trimmed, homeDir);
  if (!isAbsolute(expanded)) {
    throw new IpcError(IpcErrorCode.VALIDATION, relativeMessage);
  }
  return expanded;
}

function toView(settings: SettingsFile, homeDir: string): SettingsView {
  return {
    permissionProfile: settings.permissionProfile,
    effectLevel: settings.effectLevel,
    appearance: settings.appearance,
    claudeExecutable: settings.claudeExecutable,
    codexExecutable: settings.codexExecutable,
    agyExecutable: settings.agyExecutable,
    opencodeExecutable: settings.opencodeExecutable,
    terminalShell: settings.terminalShell,
    updateCheck: settings.updateCheck,
    updateChannel: settings.updateChannel,
    defaultTaskClass: settings.defaultTaskClass,
    definitionLibrary: settings.definitionLibrary,
    defaultWorkspace: settings.defaultWorkspace,
    defaultWorkspaceResolved: settings.defaultWorkspace ?? homeDir,
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
  homeDir,
}: SettingsServiceDeps): SettingsService {
  const serialized = createSerializer();
  return {
    async get(): Promise<SettingsView> {
      return toView(await store.readSettings(), homeDir);
    },
    set: (patch) =>
      serialized(async () => {
        const current = await store.readSettings();
        const next: SettingsFile = {
          ...current,
          permissionProfile:
            patch.permissionProfile ?? current.permissionProfile,
          effectLevel: patch.effectLevel ?? current.effectLevel,
          appearance: patch.appearance ?? current.appearance,
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
          definitionLibrary: folderSetting(
            patch.definitionLibrary,
            current.definitionLibrary,
            homeDir,
            RELATIVE_LIBRARY_MESSAGE,
          ),
          defaultWorkspace: folderSetting(
            patch.defaultWorkspace,
            current.defaultWorkspace,
            homeDir,
            RELATIVE_WORKSPACE_MESSAGE,
          ),
        };
        await store.writeSettings(next);
        const view = toView(next, homeDir);
        broadcast("settings/changed", view);
        postUpdaterConfig(toUpdaterConfigMessage(next));
        return view;
      }),
  };
}
