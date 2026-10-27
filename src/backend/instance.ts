import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  INSTANCE_FILE,
  INSTANCE_HISTORY_LIMIT,
  STORAGE_VERSION,
} from "./constants";
import { readValidated, StorageCorruptError, writeAtomic } from "./storage";

const InstanceFileSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  instances: z.array(z.string()),
});

export interface InstanceRecord {
  readonly current: string;
  readonly previous: readonly string[];
}

export function newInstanceId(): string {
  return randomUUID().replaceAll("-", "");
}

async function readPrevious(file: string): Promise<readonly string[]> {
  try {
    return (await readValidated(file, InstanceFileSchema))?.instances ?? [];
  } catch (error) {
    if (error instanceof StorageCorruptError) {
      console.warn("instance history is corrupt, starting a new one", error);
      return [];
    }
    throw error;
  }
}

export async function recordInstance(dir: string): Promise<InstanceRecord> {
  const file = join(dir, INSTANCE_FILE);
  const previous = await readPrevious(file);
  const current = newInstanceId();
  await mkdir(dir, { recursive: true });
  await writeAtomic(
    file,
    JSON.stringify({
      version: STORAGE_VERSION,
      instances: [...previous, current].slice(-INSTANCE_HISTORY_LIMIT),
    }),
  );
  return { current, previous };
}
