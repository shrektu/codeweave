import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
} from "electron";

import {
  CONNECT_MESSAGE_TYPE,
  GPU_ACCELERATED_ARG,
  PORT_CHANNEL,
} from "../shared/constants";
import { RUN_ID_ENV } from "../backend/constants";
import type { ConnectMessage } from "../shared/protocol";

import { isAppUrl } from "./appUrl";

Reflect.deleteProperty(process.env, RUN_ID_ENV);

const RENDERER_INDEX_PATH = join(import.meta.dirname, "../renderer/index.html");
const GPU_COMPOSITING_ENABLED_PREFIX = "enabled";
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

function isGpuAccelerated(): boolean {
  return app
    .getGPUFeatureStatus()
    .gpu_compositing.startsWith(GPU_COMPOSITING_ENABLED_PREFIX);
}

function connectWindowToBackend(
  window: BrowserWindow,
  backend: UtilityProcess,
): void {
  const { port1, port2 } = new MessageChannelMain();
  const connect: ConnectMessage = { type: CONNECT_MESSAGE_TYPE };
  backend.postMessage(connect, [port1]);
  window.webContents.postMessage(PORT_CHANNEL, null, [port2]);
}

function createWindow(backend: UtilityProcess): void {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    backgroundColor: "#05070d",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      additionalArguments: isGpuAccelerated() ? [GPU_ACCELERATED_ARG] : [],
    },
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const entry = rendererUrl ?? pathToFileURL(RENDERER_INDEX_PATH).href;
  const { webContents } = window;

  const blockForeignNavigation = (details: {
    url: string;
    preventDefault: () => void;
  }): void => {
    if (!isAppUrl(details.url, entry)) {
      details.preventDefault();
    }
  };
  webContents.on("will-navigate", blockForeignNavigation);
  webContents.on("will-redirect", blockForeignNavigation);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("did-finish-load", () => {
    if (isAppUrl(webContents.getURL(), entry)) {
      connectWindowToBackend(window, backend);
    }
  });

  if (rendererUrl !== undefined) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(RENDERER_INDEX_PATH);
  }
}

function focusExistingWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (window === undefined) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.focus();
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", focusExistingWindow);
  void app.whenReady().then(() => {
    const backend = utilityProcess.fork(
      join(import.meta.dirname, "backend.js"),
    );
    app.on("will-quit", () => {
      backend.kill();
    });
    createWindow(backend);
  });
} else {
  app.quit();
}

app.on("window-all-closed", () => {
  app.quit();
});
