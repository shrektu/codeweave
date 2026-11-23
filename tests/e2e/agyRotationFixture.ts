import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { delimiter, join } from "node:path";

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { z } from "zod";

import { GEMINI_DIR_FLAG_PREFIX } from "../../src/backend/agy/constants";
import { posixQuote } from "../../src/backend/agy/shellQuote";
import { ProviderId } from "../../src/domain/types";
import type { ParamsMap } from "../../src/shared/protocol";
import {
  assertIsolatedAgyEnv,
  ISOLATED_DBUS_ADDRESS,
} from "../fakes/agyHomeGuard";

import { writeKeyringPreload } from "./opencodeRotationFixture";
import { typeConfigDirectory } from "./pathFieldE2e";

export const AGY_ACCOUNT_LABEL = "A";
export const AGY_PATH_ERROR =
  "the agy CLI 1.4.11 is not on PATH; install the pinned Antigravity CLI first";

const AGY_BINARY = "agy";
const AGY_ACCOUNT_DIR = "a";
const AGY_STATE_DIR = "antigravity-cli";
const AGY_SETTINGS_FILE = "settings.json";
const AGY_SETTINGS = { modelProvider: "gemini" } as const;
const FAKE_GEMINI_API_KEY = "fake-gemini-api-key-for-local-mock";
const AGENT_HOME_DIR = "agy-home";
const BUILT_HOOK_ENTRY = ["out", "main", "agyHook.js"] as const;
const HOOK_LAUNCHER_FILE = "agy-hook-launcher.sh";
const HOOK_LAUNCHER_MODE = 0o755;
const LOOPBACK_HOST = "127.0.0.1";
const PROC_ROOT = "/proc";
const PID_PATTERN = /^\d+$/;
const NUL = "\0";
const EXECUTE_BITS = 0o111;
const VANISHED_PROCESS_CODES: readonly string[] = ["ENOENT", "ESRCH"];
const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const ADD_TIMEOUT_MS = 30_000;
const GEMINI_OPTION = "Gemini";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

export interface AgyXdgEnv {
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_CACHE_HOME: string;
  readonly XDG_DATA_HOME: string;
  readonly XDG_STATE_HOME: string;
}

export interface AgyAgentEnv extends AgyXdgEnv {
  readonly HOME: string;
  readonly GEMINI_API_KEY: string;
  readonly GOOGLE_GEMINI_BASE_URL: string;
  readonly DBUS_SESSION_BUS_ADDRESS: string;
}

export interface AgyIsolation {
  readonly geminiDir: string;
  readonly agentEnv: AgyAgentEnv;
}

export function agyConfigDir(userData: string): string {
  return join(userData, "accounts", AGY_ACCOUNT_DIR);
}

export function agyAddParams(userData: string): ParamsMap["accounts/add"] {
  return {
    label: AGY_ACCOUNT_LABEL,
    configDir: agyConfigDir(userData),
    provider: ProviderId.gemini,
  };
}

function isExecutableFile(path: string): boolean {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats?.isFile() === true && (stats.mode & EXECUTE_BITS) !== 0;
}

export function agyBinaryOnPath(pathVariable = process.env.PATH ?? ""): string {
  const found = pathVariable
    .split(delimiter)
    .map((dir) => join(dir, AGY_BINARY))
    .find(isExecutableFile);
  if (found === undefined) {
    throw new Error(AGY_PATH_ERROR);
  }
  return found;
}

export function assertAgyIsolated(isolation: AgyIsolation): void {
  const { agentEnv, geminiDir } = isolation;
  assertIsolatedAgyEnv({
    home: agentEnv.HOME,
    geminiDir,
    baseUrl: agentEnv.GOOGLE_GEMINI_BASE_URL,
    dbusAddress: agentEnv.DBUS_SESSION_BUS_ADDRESS,
    xdgDirs: {
      XDG_CONFIG_HOME: agentEnv.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: agentEnv.XDG_CACHE_HOME,
      XDG_DATA_HOME: agentEnv.XDG_DATA_HOME,
      XDG_STATE_HOME: agentEnv.XDG_STATE_HOME,
    },
  });
}

export async function createAgyIsolation(
  root: string,
  geminiDir: string,
  baseUrl: string,
): Promise<AgyIsolation> {
  const home = join(root, AGENT_HOME_DIR);
  const isolation: AgyIsolation = {
    geminiDir,
    agentEnv: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      GEMINI_API_KEY: FAKE_GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: baseUrl,
      DBUS_SESSION_BUS_ADDRESS: ISOLATED_DBUS_ADDRESS,
    },
  };
  assertAgyIsolated(isolation);
  await mkdir(home, { recursive: true });
  return isolation;
}

export async function writeAgySettings(isolation: AgyIsolation): Promise<void> {
  assertAgyIsolated(isolation);
  const stateDir = join(isolation.geminiDir, AGY_STATE_DIR);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, AGY_SETTINGS_FILE),
    JSON.stringify(AGY_SETTINGS),
  );
}

export function builtAgyHookEntry(): string {
  const entry = join(ROOT_DIR, ...BUILT_HOOK_ENTRY);
  if (!existsSync(entry)) {
    throw new Error(`${entry} is missing; run \`pnpm build\` first`);
  }
  return entry;
}

export async function writeHookLauncher(
  dir: string,
  hookEntry: string,
): Promise<string> {
  const launcher = join(dir, HOOK_LAUNCHER_FILE);
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${posixQuote(process.execPath)} ${posixQuote(hookEntry)}\n`,
    { mode: HOOK_LAUNCHER_MODE },
  );
  return launcher;
}

async function cmdlineOf(pid: string): Promise<string> {
  return readFile(join(PROC_ROOT, pid, "cmdline"), "utf8").catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        VANISHED_PROCESS_CODES.includes(error.code)
      ) {
        return "";
      }
      throw error;
    },
  );
}

export async function agyProcessPids(geminiDir: string): Promise<string[]> {
  const flag = `${GEMINI_DIR_FLAG_PREFIX}${geminiDir}`;
  const pids = (await readdir(PROC_ROOT)).filter((entry) =>
    PID_PATTERN.test(entry),
  );
  const matches = await Promise.all(
    pids.map(async (pid) =>
      (await cmdlineOf(pid)).split(NUL).includes(flag) ? [pid] : [],
    ),
  );
  return matches.flat();
}

export async function launchApp(
  root: string,
  userData: string,
  isolation: AgyIsolation,
): Promise<ElectronApplication> {
  assertAgyIsolated(isolation);
  const keyringArgs =
    process.platform === "linux" ? ["-r", await writeKeyringPreload(root)] : [];
  return electron.launch({
    args: [...keyringArgs, ".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [USER_DATA_DIR_ENV]: userData,
      [TEST_AGENT_ENV_VAR]: JSON.stringify(isolation.agentEnv),
    },
  });
}

export async function submitAccount(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(
    dialog.getByRole("listitem").filter({ hasText: new RegExp(`^${label}`) }),
  ).toBeVisible({ timeout: ADD_TIMEOUT_MS });
}

export async function addGeminiAccount(
  page: Page,
  configDir: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByLabel("Agent").selectOption({ label: GEMINI_OPTION });
  await dialog.getByLabel("Label", { exact: true }).fill(AGY_ACCOUNT_LABEL);
  await typeConfigDirectory(dialog, configDir);
  await submitAccount(page, AGY_ACCOUNT_LABEL);
}

export async function chooseProfile(
  page: Page,
  profileLabel: string,
): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const profile = page.getByRole("radio", { name: profileLabel, exact: true });
  await profile.click();
  await expect(profile).toBeChecked();
  await page.getByRole("button", { name: "Close" }).click();
}

export async function stubFolderDialog(
  app: ElectronApplication,
  folder: string,
): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}

const ChatBodySchema = z.looseObject({
  tools: z.array(z.unknown()).default([]),
});

export interface ProxiedChatRequest {
  readonly body: string;
  readonly hasTools: boolean;
}

export interface ChatProxy {
  readonly url: string;
  requests(): readonly ProxiedChatRequest[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function forward(
  origin: string,
  req: IncomingMessage,
  res: ServerResponse,
  requests: ProxiedChatRequest[],
): Promise<void> {
  const body = await readBody(req);
  const parsed = ChatBodySchema.safeParse(JSON.parse(body || "{}"));
  requests.push({
    body,
    hasTools: parsed.success && parsed.data.tools.length > 0,
  });
  const upstream = await fetch(`${origin}${req.url ?? ""}`, {
    method: req.method ?? "POST",
    headers: {
      authorization: req.headers.authorization ?? "",
      "content-type": req.headers["content-type"] ?? "application/json",
    },
    body,
  });
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/plain",
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

export async function startChatProxy(targetUrl: string): Promise<ChatProxy> {
  const target = new URL(targetUrl);
  const requests: ProxiedChatRequest[] = [];
  const server = createServer((req, res) => {
    forward(target.origin, req, res, requests).catch((error: unknown) => {
      console.error("chat proxy failed", error);
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("chat proxy has no TCP address");
  }
  return {
    url: `http://${LOOPBACK_HOST}:${String(address.port)}${target.pathname}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
