import { resolve } from "node:path";

import type { AgentEvent, ToolCallStatus } from "../../domain/events";
import {
  DEFAULT_TOOL_KIND,
  OPTION_KIND_ALLOW_ALWAYS,
  OPTION_KIND_ALLOW_ONCE,
  OPTION_KIND_REJECT_ONCE,
} from "../constants";

import {
  OPTION_NAME_ALLOW_ALWAYS,
  OPTION_NAME_ALLOW_ONCE,
  OPTION_NAME_REJECT,
  OpencodeEventType,
  OpencodePartType,
  OpencodePermissionResponse,
  OpencodeRole,
  OpencodeToolStatus,
  TITLE_EDIT_FILE,
  TITLE_FETCH_URL,
  TITLE_RUN_COMMAND,
  TOOL_KIND_EDIT,
  TOOL_KIND_EXECUTE,
  TOOL_KIND_FETCH,
  TOOL_KIND_READ,
  TOOL_KIND_SEARCH,
} from "./constants";
import type {
  OpencodeEvent,
  PermissionAskedProperties,
  SessionInfo,
  TextPart,
  ToolPart,
} from "./protocol";
import { servedModelName } from "./servedModel";

export const SessionScope = {
  own: "own",
  descendant: "descendant",
  foreign: "foreign",
} as const;
export type SessionScope = (typeof SessionScope)[keyof typeof SessionScope];

interface MessageInfo {
  readonly id: string;
  readonly role: string;
  readonly modelID?: string | undefined;
  readonly providerID?: string | undefined;
}

export interface OpencodeEventMapper {
  map(event: OpencodeEvent): AgentEvent[];
  scopeOf(event: OpencodeEvent): SessionScope;
  beginTurn(): void;
}

const TOOL_KINDS: Readonly<Record<string, string>> = {
  bash: TOOL_KIND_EXECUTE,
  edit: TOOL_KIND_EDIT,
  write: TOOL_KIND_EDIT,
  patch: TOOL_KIND_EDIT,
  multiedit: TOOL_KIND_EDIT,
  read: TOOL_KIND_READ,
  list: TOOL_KIND_READ,
  glob: TOOL_KIND_SEARCH,
  grep: TOOL_KIND_SEARCH,
  webfetch: TOOL_KIND_FETCH,
};

const PERMISSION_KINDS: Readonly<Record<string, string>> = {
  bash: TOOL_KIND_EXECUTE,
  edit: TOOL_KIND_EDIT,
  webfetch: TOOL_KIND_FETCH,
};

const PERMISSION_TITLES: Readonly<Record<string, string>> = {
  bash: TITLE_RUN_COMMAND,
  edit: TITLE_EDIT_FILE,
  webfetch: TITLE_FETCH_URL,
};

const TOOL_STATUSES: Readonly<Record<string, ToolCallStatus>> = {
  [OpencodeToolStatus.pending]: "pending",
  [OpencodeToolStatus.running]: "in_progress",
  [OpencodeToolStatus.completed]: "completed",
  [OpencodeToolStatus.error]: "failed",
};

export const PERMISSION_OPTIONS = [
  {
    optionId: OpencodePermissionResponse.once,
    name: OPTION_NAME_ALLOW_ONCE,
    kind: OPTION_KIND_ALLOW_ONCE,
  },
  {
    optionId: OpencodePermissionResponse.always,
    name: OPTION_NAME_ALLOW_ALWAYS,
    kind: OPTION_KIND_ALLOW_ALWAYS,
  },
  {
    optionId: OpencodePermissionResponse.reject,
    name: OPTION_NAME_REJECT,
    kind: OPTION_KIND_REJECT_ONCE,
  },
] as const;

function sessionOf(event: OpencodeEvent): string | undefined {
  switch (event.type) {
    case OpencodeEventType.partUpdated:
      return event.properties.part.sessionID;
    case OpencodeEventType.messageUpdated:
      return event.properties.info.sessionID;
    case OpencodeEventType.sessionCreated:
    case OpencodeEventType.sessionUpdated:
      return event.properties.info.id;
    default:
      return event.properties.sessionID;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolStatusOf(part: ToolPart): ToolCallStatus {
  return TOOL_STATUSES[part.state.status] ?? "pending";
}

function toolUpdate(part: ToolPart): AgentEvent {
  const { input, output, error } = part.state;
  const text = output ?? error;
  return {
    type: "tool_call_update",
    toolCallId: part.callID,
    status: toolStatusOf(part),
    ...(input === undefined ? {} : { rawInput: input }),
    ...(text === undefined ? {} : { output: text }),
  };
}

function toolCall(part: ToolPart): AgentEvent {
  const { input, title } = part.state;
  return {
    type: "tool_call",
    toolCallId: part.callID,
    title: title ?? part.tool,
    kind: TOOL_KINDS[part.tool] ?? DEFAULT_TOOL_KIND,
    status: toolStatusOf(part),
    ...(input === undefined ? {} : { rawInput: input }),
  };
}

function editLocations(
  properties: PermissionAskedProperties,
  cwd: string,
): string[] {
  const candidates = [
    stringOf(properties.metadata.filepath),
    ...properties.patterns,
  ].filter((path) => path !== undefined);
  return [...new Set(candidates.map((path) => resolve(cwd, path)))];
}

function permissionInput(
  properties: PermissionAskedProperties,
  locations: readonly string[],
): { rawInput?: unknown } {
  if (properties.permission === "bash") {
    const command =
      stringOf(properties.metadata.command) ?? properties.patterns[0];
    return command === undefined ? {} : { rawInput: { command } };
  }
  const [filePath] = locations;
  return properties.permission === "edit" && filePath !== undefined
    ? { rawInput: { file_path: filePath } }
    : {};
}

function permissionRequest(
  properties: PermissionAskedProperties,
  cwd: string,
): AgentEvent {
  const locations =
    properties.permission === "edit" ? editLocations(properties, cwd) : [];
  return {
    type: "permission_request",
    requestId: properties.id,
    toolCallId: properties.tool?.callID ?? properties.id,
    title: PERMISSION_TITLES[properties.permission] ?? properties.permission,
    kind: PERMISSION_KINDS[properties.permission] ?? DEFAULT_TOOL_KIND,
    ...permissionInput(properties, locations),
    locations,
    options: PERMISSION_OPTIONS,
  };
}

export function createEventMapper(
  sessionId: string,
  cwd: string,
): OpencodeEventMapper {
  const texts = new Map<string, string>();
  const tools = new Set<string>();
  const roles = new Map<string, string>();
  const descendants = new Set<string>();
  let reportedModel: string | null = null;

  function scopeOf(event: OpencodeEvent): SessionScope {
    const owner = sessionOf(event);
    if (owner === undefined || owner === sessionId) {
      return SessionScope.own;
    }
    return descendants.has(owner)
      ? SessionScope.descendant
      : SessionScope.foreign;
  }

  function observeSession(info: SessionInfo): void {
    const { parentID } = info;
    if (
      parentID !== null &&
      parentID !== undefined &&
      (parentID === sessionId || descendants.has(parentID))
    ) {
      descendants.add(info.id);
    }
  }

  function isAssistantText(part: TextPart): boolean {
    return (
      part.synthetic !== true &&
      part.messageID !== undefined &&
      roles.get(part.messageID) === OpencodeRole.assistant
    );
  }

  function mapText(part: TextPart): AgentEvent[] {
    if (!isAssistantText(part)) {
      return [];
    }
    const previous = texts.get(part.id) ?? "";
    texts.set(part.id, part.text);
    const text = part.text.startsWith(previous)
      ? part.text.slice(previous.length)
      : part.text;
    return text === "" ? [] : [{ type: "text", messageId: part.id, text }];
  }

  function mapMessage(info: MessageInfo): AgentEvent[] {
    roles.set(info.id, info.role);
    if (info.role !== OpencodeRole.assistant || info.modelID === undefined) {
      return [];
    }
    const model = servedModelName(info.providerID, info.modelID);
    if (model === reportedModel) {
      return [];
    }
    reportedModel = model;
    return [{ type: "model", model }];
  }

  function mapTool(part: ToolPart): AgentEvent[] {
    const seen = tools.has(part.callID);
    tools.add(part.callID);
    return [seen ? toolUpdate(part) : toolCall(part)];
  }

  return {
    scopeOf,
    beginTurn() {
      reportedModel = null;
    },
    map(event) {
      const scope = scopeOf(event);
      switch (event.type) {
        case OpencodeEventType.sessionCreated:
        case OpencodeEventType.sessionUpdated:
          observeSession(event.properties.info);
          return [];
        case OpencodeEventType.messageUpdated:
          return scope === SessionScope.own
            ? mapMessage(event.properties.info)
            : [];
        case OpencodeEventType.partUpdated: {
          const { part } = event.properties;
          if (scope !== SessionScope.own) {
            return [];
          }
          return part.type === OpencodePartType.text
            ? mapText(part)
            : mapTool(part);
        }
        case OpencodeEventType.permissionAsked:
          return scope === SessionScope.foreign
            ? []
            : [permissionRequest(event.properties, cwd)];
        default:
          return [];
      }
    },
  };
}
