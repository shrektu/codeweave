import { contextBridge, ipcRenderer } from "electron";

import type { CodeweaveApi } from "../shared/api";
import { GPU_ACCELERATED_ARG, PORT_CHANNEL } from "../shared/constants";

const api: CodeweaveApi = {
  gpuAccelerated: process.argv.includes(GPU_ACCELERATED_ARG),
};

ipcRenderer.on(PORT_CHANNEL, (event) => {
  window.postMessage(PORT_CHANNEL, "*", event.ports);
});

contextBridge.exposeInMainWorld("codeweave", api);
