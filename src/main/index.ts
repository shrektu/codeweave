import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  safeStorage,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type UtilityProcess,
} from "electron";
import electronUpdater from "electron-updater";

import {
  CONNECT_MESSAGE_TYPE,
  GET_AVAILABLE_UPDATE_CHANNEL,
  GET_GPU_ACCELERATED_CHANNEL,
  GPU_ACCELERATED_CHANNEL,
  OPEN_UPDATE_RELEASE_CHANNEL,
  PICK_FOLDER_CHANNEL,
  PORT_CHANNEL,
  UPDATE_AVAILABLE_CHANNEL,
} from "../shared/constants";
import { RUN_ID_ENV } from "../backend/constants";
import type { AvailableUpdate } from "../shared/api";
import type { ConnectMessage } from "../shared/protocol";
import { UpdaterConfigMessageSchema } from "../shared/updates";
import { VaultRequestSchema } from "../shared/vault";

import { isAppUrl } from "./appUrl";
import {
  buildBackendArgs,
  TEST_AGENT_ENV_VAR,
  TEST_UPDATE_FEED_ENV_VAR,
} from "./backendArgs";
import {
  isGpuAccelerated,
  watchGpuAcceleration,
  type GpuStatusSource,
} from "./gpuAcceleration";
import { createSecretVault, handleVaultRequest } from "./secretVault";
import {
  createBackendShutdownPort,
  createQuitGuard,
  requestBackendShutdown,
  SHUTDOWN_TIMEOUT_MS,
} from "./shutdown";
import {
  createUpdateNotifier,
  openAvailableRelease,
  type UpdateNotifier,
} from "./updates";
import { resolveUserDataOverride } from "./userDataOverride";
import { linuxWindowIcon } from "./windowIcon";

Reflect.deleteProperty(process.env, RUN_ID_ENV);

const RENDERER_INDEX_PATH = join(import.meta.dirname, "../renderer/index.html");
const LINUX_PLATFORM = "linux";
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

const gpuStatusSource: GpuStatusSource = {
  compositingStatus: () => app.getGPUFeatureStatus().gpu_compositing,
  onInfoUpdate: (listener) => {
    app.on("gpu-info-update", listener);
  },
};

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url ?? "", rendererEntry());
}

function rendererEntry(): string {
  return (
    process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(RENDERER_INDEX_PATH).href
  );
}

async function pickFolder(event: IpcMainInvokeEvent): Promise<string | null> {
  if (!isAppUrl(event.senderFrame?.url ?? "", rendererEntry())) {
    return null;
  }
  const options: OpenDialogOptions = { properties: ["openDirectory"] };
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function logUpdateProblem(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(message);
  } else {
    console.warn(message, error);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function broadcastAvailableUpdate(version: string | null): void {
  const update: AvailableUpdate | null = version === null ? null : { version };
  broadcast(UPDATE_AVAILABLE_CHANNEL, update);
}

function createNotifier(): UpdateNotifier {
  return createUpdateNotifier({
    updater: electronUpdater.autoUpdater,
    isPackaged: app.isPackaged,
    testFeedUrl: app.isPackaged
      ? undefined
      : process.env[TEST_UPDATE_FEED_ENV_VAR],
    setInterval,
    clearInterval,
    onChanged: broadcastAvailableUpdate,
    log: logUpdateProblem,
  });
}

function registerUpdateHandlers(notifier: UpdateNotifier): void {
  ipcMain.handle(
    GET_AVAILABLE_UPDATE_CHANNEL,
    (event): AvailableUpdate | null => {
      const version = notifier.available();
      return fromApp(event) && version !== null ? { version } : null;
    },
  );
  ipcMain.handle(OPEN_UPDATE_RELEASE_CHANNEL, async (event) => {
    if (fromApp(event)) {
      await openAvailableRelease(notifier, (url) => shell.openExternal(url));
    }
  });
}

function startBackend(notifier: UpdateNotifier): UtilityProcess {
  const backend = utilityProcess.fork(
    join(import.meta.dirname, "backend.js"),
    buildBackendArgs({
      userData: app.getPath("userData"),
      isPackaged: app.isPackaged,
      testAgentEnv: process.env[TEST_AGENT_ENV_VAR],
    }),
  );
  const vault = createSecretVault(safeStorage, process.platform);
  backend.on("message", (message: unknown) => {
    const request = VaultRequestSchema.safeParse(message);
    if (request.success) {
      backend.postMessage(handleVaultRequest(vault, request.data));
      return;
    }
    const config = UpdaterConfigMessageSchema.safeParse(message);
    if (config.success) {
      notifier.configure(config.data);
    }
  });
  const port = createBackendShutdownPort(backend);
  app.on(
    "before-quit",
    createQuitGuard({
      requestShutdown: () => requestBackendShutdown(port, SHUTDOWN_TIMEOUT_MS),
      kill: () => {
        backend.kill();
      },
      quit: () => {
        app.quit();
      },
    }),
  );
  return backend;
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
    ...(process.platform === LINUX_PLATFORM
      ? {
          icon: linuxWindowIcon(
            app.isPackaged,
            process.resourcesPath,
            app.getAppPath(),
          ),
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "../preload/index.cjs"),
    },
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const entry = rendererEntry();
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

const userDataOverride = resolveUserDataOverride({
  isPackaged: app.isPackaged,
  env: process.env,
});
if (userDataOverride !== null) {
  app.setPath("userData", userDataOverride);
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", focusExistingWindow);
  void app.whenReady().then(() => {
    ipcMain.handle(PICK_FOLDER_CHANNEL, (event) => pickFolder(event));
    const notifier = createNotifier();
    registerUpdateHandlers(notifier);
    app.on("before-quit", () => {
      notifier.dispose();
    });
    ipcMain.handle(
      GET_GPU_ACCELERATED_CHANNEL,
      (event): boolean => fromApp(event) && isGpuAccelerated(gpuStatusSource),
    );
    watchGpuAcceleration(gpuStatusSource, (accelerated) => {
      broadcast(GPU_ACCELERATED_CHANNEL, accelerated);
    });
    createWindow(startBackend(notifier));
  });
} else {
  app.quit();
}

app.on("window-all-closed", () => {
  app.quit();
});
