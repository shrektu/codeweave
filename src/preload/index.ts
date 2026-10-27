import { contextBridge, ipcRenderer } from "electron";

import type { CodeweaveApi } from "../shared/api";
import {
  GPU_ACCELERATED_ARG,
  PICK_FOLDER_CHANNEL,
  PORT_CHANNEL,
} from "../shared/constants";

const api: CodeweaveApi = {
  gpuAccelerated: process.argv.includes(GPU_ACCELERATED_ARG),
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(PICK_FOLDER_CHANNEL) as Promise<string | null>,
};

ipcRenderer.on(PORT_CHANNEL, (event) => {
  window.postMessage(PORT_CHANNEL, "*", event.ports);
});

contextBridge.exposeInMainWorld("codeweave", api);
