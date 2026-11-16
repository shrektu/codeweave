import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { AvailableUpdate, CodeweaveApi } from "../shared/api";
import {
  GET_AVAILABLE_UPDATE_CHANNEL,
  GPU_ACCELERATED_ARG,
  OPEN_UPDATE_RELEASE_CHANNEL,
  PICK_FOLDER_CHANNEL,
  PORT_CHANNEL,
  UPDATE_AVAILABLE_CHANNEL,
} from "../shared/constants";

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

const api: CodeweaveApi = {
  gpuAccelerated: process.argv.includes(GPU_ACCELERATED_ARG),
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(PICK_FOLDER_CHANNEL) as Promise<string | null>,
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
};

ipcRenderer.on(PORT_CHANNEL, (event) => {
  window.postMessage(PORT_CHANNEL, "*", event.ports);
});

contextBridge.exposeInMainWorld("codeweave", api);
