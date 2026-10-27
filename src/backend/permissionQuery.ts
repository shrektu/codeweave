import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentEvent, PermissionOption } from "../domain/events";
import type {
  PermissionDecision,
  PermissionQuery,
} from "../domain/permissionPolicy";
import { UNRESOLVED_PATH_PREFIX } from "../domain/permissionRules";

import {
  ACP_KINDS_EDIT,
  ACP_KINDS_EXECUTE,
  ACP_KINDS_READ,
  FILE_URL_PREFIX,
  OPTION_KIND_ALLOW_ONCE,
  OPTION_KIND_REJECT_ONCE,
} from "./constants";

type PermissionRequest = Extract<AgentEvent, { type: "permission_request" }>;

const QUERY_KINDS: ReadonlyMap<string, PermissionQuery["kind"]> = new Map([
  ...ACP_KINDS_READ.map((kind) => [kind, "read"] as const),
  ...ACP_KINDS_EDIT.map((kind) => [kind, "edit"] as const),
  ...ACP_KINDS_EXECUTE.map((kind) => [kind, "execute"] as const),
]);

function fieldOf(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? (Reflect.get(source, key) as unknown)
    : undefined;
}

function absolutePath(raw: string, cwd: string): string {
  if (raw.startsWith(UNRESOLVED_PATH_PREFIX)) {
    return raw;
  }
  if (raw.startsWith(FILE_URL_PREFIX)) {
    try {
      return fileURLToPath(raw);
    } catch (error) {
      console.warn(`unreadable file URL in permission request: ${raw}`, error);
      return `${UNRESOLVED_PATH_PREFIX}${raw}`;
    }
  }
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function pathsOf(event: PermissionRequest, cwd: string): string[] {
  const filePath = fieldOf(event.rawInput, "file_path");
  const raw =
    typeof filePath === "string"
      ? [...event.locations, filePath]
      : event.locations;
  return [...new Set(raw.map((path) => absolutePath(path, cwd)))];
}

export function toPermissionQuery(
  event: PermissionRequest,
  cwd: string,
): PermissionQuery {
  const kind = QUERY_KINDS.get(event.kind) ?? "other";
  switch (kind) {
    case "edit":
      return { kind, paths: pathsOf(event, cwd) };
    case "execute": {
      const command = fieldOf(event.rawInput, "command");
      return typeof command === "string" ? { kind, command } : { kind };
    }
    default:
      return { kind };
  }
}

export function pickOption(
  decision: PermissionDecision,
  options: readonly PermissionOption[],
): string | null {
  const wanted = {
    allow: OPTION_KIND_ALLOW_ONCE,
    deny: OPTION_KIND_REJECT_ONCE,
    ask: null,
  }[decision.action];
  return options.find((option) => option.kind === wanted)?.optionId ?? null;
}
