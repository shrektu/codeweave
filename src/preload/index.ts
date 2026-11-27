import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { AvailableUpdate, CodeweaveApi } from "../shared/api";
import {
  GET_AVAILABLE_UPDATE_CHANNEL,
  GET_GPU_ACCELERATED_CHANNEL,
  GPU_ACCELERATED_CHANNEL,
  HOME_DIR_ARG,
  NOTIFICATION_CLICKED_CHANNEL,
  OPEN_EXTERNAL_LINK_CHANNEL,
  OPEN_UPDATE_RELEASE_CHANNEL,
  PICK_FILE_CHANNEL,
  PICK_FOLDER_CHANNEL,
  PORT_CHANNEL,
  SET_THEME_SOURCE_CHANNEL,
  SHOW_NOTIFICATION_CHANNEL,
  UPDATE_AVAILABLE_CHANNEL,
} from "../shared/constants";
import type { NotificationTarget } from "../shared/notifications";

import { createGpuAccelerationState } from "./gpuAcceleration";

function toAvailableUpdate(value: unknown): AvailableUpdate | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  ) {
    return { version: value.version };
  }
  return null;
}

function toNotificationTarget(value: unknown): NotificationTarget | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return null;
  }
  if (
    value.kind === "session" &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  ) {
    return { kind: "session", sessionId: value.sessionId };
  }
  if (
    value.kind === "flowRun" &&
    "runId" in value &&
    typeof value.runId === "string"
  ) {
    return { kind: "flowRun", runId: value.runId };
  }
  return null;
}

function homeDirFromArgv(argv: readonly string[]): string | null {
  const prefix = `${HOME_DIR_ARG}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  const value = match?.slice(prefix.length) ?? "";
  return value === "" ? null : value;
}

const gpuAcceleration = createGpuAccelerationState({
  fetch: () => ipcRenderer.invoke(GET_GPU_ACCELERATED_CHANNEL),
  subscribe: (handler) => {
    ipcRenderer.on(GPU_ACCELERATED_CHANNEL, (_event, payload: unknown) => {
      handler(payload);
    });
  },
});

const api: CodeweaveApi = {
  isGpuAccelerated: () => gpuAcceleration.current(),
  onGpuAcceleratedChanged: (listener) => gpuAcceleration.onChanged(listener),
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(PICK_FOLDER_CHANNEL) as Promise<string | null>,
  pickFile: (): Promise<string | null> =>
    ipcRenderer.invoke(PICK_FILE_CHANNEL) as Promise<string | null>,
  homeDir: homeDirFromArgv(process.argv),
  getAvailableUpdate: async (): Promise<AvailableUpdate | null> =>
    toAvailableUpdate(await ipcRenderer.invoke(GET_AVAILABLE_UPDATE_CHANNEL)),
  onUpdateAvailable: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(toAvailableUpdate(payload));
    };
    ipcRenderer.on(UPDATE_AVAILABLE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(UPDATE_AVAILABLE_CHANNEL, handler);
    };
  },
  openUpdateRelease: async (): Promise<void> => {
    await ipcRenderer.invoke(OPEN_UPDATE_RELEASE_CHANNEL);
  },
  openLink: async (url): Promise<void> => {
    await ipcRenderer.invoke(OPEN_EXTERNAL_LINK_CHANNEL, url);
  },
  platform: process.platform,
  setThemeSource: async (appearance): Promise<void> => {
    await ipcRenderer.invoke(SET_THEME_SOURCE_CHANNEL, appearance);
  },
  notify: async (notification): Promise<void> => {
    await ipcRenderer.invoke(SHOW_NOTIFICATION_CHANNEL, notification);
  },
  onNotificationClicked: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const target = toNotificationTarget(payload);
      if (target !== null) {
        listener(target);
      }
    };
    ipcRenderer.on(NOTIFICATION_CLICKED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(NOTIFICATION_CLICKED_CHANNEL, handler);
    };
  },
};

ipcRenderer.on(PORT_CHANNEL, (event) => {
  window.postMessage(PORT_CHANNEL, "*", event.ports);
});

contextBridge.exposeInMainWorld("codeweave", api);
