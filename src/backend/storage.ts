import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  EffectLevel,
  PermissionProfile,
  ProviderId,
  SwitchReason,
  type Account,
  type SwitchLogEntry,
} from "../domain/types";

import {
  ACCOUNTS_FILE,
  SETTINGS_FILE,
  STORAGE_VERSION,
  SWITCH_LOG_FILE,
  TEMP_FILE_SUFFIX,
} from "./constants";

const AccountSchema = z.object({
  id: z.string(),
  provider: z.enum(ProviderId),
  label: z.string(),
  configDir: z.string(),
  order: z.number().int(),
});

export const AccountsFileSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  accounts: z.array(AccountSchema),
});

export const SettingsFileSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  permissionProfile: z.enum(PermissionProfile),
  effectLevel: z.enum(EffectLevel),
  claudeExecutable: z.string().nullable(),
  codexExecutable: z.string().nullable().default(null),
});

const SwitchLogEntrySchema = z.object({
  at: z.number(),
  sessionId: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  reason: z.enum(SwitchReason),
  resetsAt: z.number().nullable(),
  contextPackageChars: z.number(),
});

function parseSwitchLogLine(
  line: string,
  lineNumber: number,
): SwitchLogEntry | null {
  const skipped = `Skipping invalid switch log line ${String(lineNumber)}`;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (error) {
    console.warn(skipped, error);
    return null;
  }
  const parsed = SwitchLogEntrySchema.safeParse(json);
  if (!parsed.success) {
    console.warn(skipped, parsed.error);
    return null;
  }
  return parsed.data;
}

export type AccountsFile = z.infer<typeof AccountsFileSchema>;
export type SettingsFile = z.infer<typeof SettingsFileSchema>;

const DEFAULT_SETTINGS: SettingsFile = {
  version: STORAGE_VERSION,
  permissionProfile: PermissionProfile.bypass,
  effectLevel: EffectLevel.auto,
  claudeExecutable: null,
  codexExecutable: null,
};

export class StorageCorruptError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`Storage file is corrupt: ${file} (${detail})`);
    this.file = file;
    this.name = "StorageCorruptError";
  }
}

export interface JsonStore {
  readAccounts(): Promise<Account[]>;
  writeAccounts(accounts: readonly Account[]): Promise<void>;
  readSettings(): Promise<SettingsFile>;
  writeSettings(settings: SettingsFile): Promise<void>;
  appendSwitchLog(entry: SwitchLogEntry): Promise<void>;
  readSwitchLog(limit: number): Promise<SwitchLogEntry[]>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

export async function readValidated<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const text = await readText(file);
  if (text === null) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new StorageCorruptError(
      file,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new StorageCorruptError(file, parsed.error.message);
  }
  return parsed.data;
}

export async function writeAtomic(
  file: string,
  content: string,
): Promise<void> {
  const temp = `${file}.${randomUUID()}${TEMP_FILE_SUFFIX}`;
  try {
    await writeFile(temp, content);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function createJsonStore(dir: string): JsonStore {
  const accountsPath = join(dir, ACCOUNTS_FILE);
  const settingsPath = join(dir, SETTINGS_FILE);
  const switchLogPath = join(dir, SWITCH_LOG_FILE);

  async function writeJson<T>(
    file: string,
    schema: z.ZodType<T>,
    value: T,
  ): Promise<void> {
    await readValidated(file, schema);
    await mkdir(dir, { recursive: true });
    await writeAtomic(file, JSON.stringify(schema.parse(value), null, 2));
  }

  return {
    async readAccounts(): Promise<Account[]> {
      const file = await readValidated(accountsPath, AccountsFileSchema);
      return file?.accounts ?? [];
    },
    writeAccounts: (accounts) =>
      writeJson(accountsPath, AccountsFileSchema, {
        version: STORAGE_VERSION,
        accounts: [...accounts],
      }),
    async readSettings(): Promise<SettingsFile> {
      return (
        (await readValidated(settingsPath, SettingsFileSchema)) ??
        DEFAULT_SETTINGS
      );
    },
    writeSettings: (settings) =>
      writeJson(settingsPath, SettingsFileSchema, settings),
    async appendSwitchLog(entry): Promise<void> {
      await mkdir(dir, { recursive: true });
      await appendFile(switchLogPath, `${JSON.stringify(entry)}\n`);
    },
    async readSwitchLog(limit): Promise<SwitchLogEntry[]> {
      const text = await readText(switchLogPath);
      const entries = (text?.split("\n") ?? [])
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => line.trim() !== "")
        .map(({ line, lineNumber }) => parseSwitchLogLine(line, lineNumber))
        .filter((entry) => entry !== null);
      return entries.slice(Math.max(0, entries.length - limit));
    },
  };
}
