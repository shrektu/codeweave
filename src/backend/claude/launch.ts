import { createRequire } from "node:module";

import {
  ASAR_SEGMENT_PATTERN,
  ASAR_UNPACKED_SEGMENT,
  CLAUDE_ACP_ENTRY,
  CLAUDE_ACP_PACKAGE,
  ELECTRON_RUN_AS_NODE_ENV,
  ENABLE_TOOL_SEARCH_ENV,
  FLAG_DISABLED,
  FLAG_ENABLED,
  LAUNCHER_SCRIPT,
} from "../constants";

export interface ClaudeLaunchInput {
  readonly execPath: string;
  readonly adapterEntry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly toolsEnabled?: boolean;
}

export interface ClaudeLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export function buildClaudeLaunch(input: ClaudeLaunchInput): ClaudeLaunch {
  return {
    command: input.execPath,
    args: ["-e", LAUNCHER_SCRIPT, input.adapterEntry],
    env: {
      ...input.env,
      [ELECTRON_RUN_AS_NODE_ENV]: FLAG_ENABLED,
      ...(input.toolsEnabled === true
        ? { [ENABLE_TOOL_SEARCH_ENV]: FLAG_DISABLED }
        : {}),
    },
  };
}

export function resolveAdapterEntry(resolved: string): string {
  return resolved.replace(ASAR_SEGMENT_PATTERN, ASAR_UNPACKED_SEGMENT);
}

export function locateClaudeAcpEntry(): string {
  const requireFromHere = createRequire(import.meta.url);
  return resolveAdapterEntry(
    requireFromHere.resolve(`${CLAUDE_ACP_PACKAGE}/${CLAUDE_ACP_ENTRY}`),
  );
}
