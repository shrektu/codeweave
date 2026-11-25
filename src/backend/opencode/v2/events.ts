import { resolve } from "node:path";

import { z } from "zod";

import { contextUsageOf } from "../../../domain/contextUsage";
import {
  DiffOmission,
  FileChange,
  type AgentEvent,
} from "../../../domain/events";
import { DEFAULT_TOOL_KIND } from "../../constants";
import {
  TITLE_EDIT_FILE,
  TITLE_FETCH_URL,
  TITLE_RUN_COMMAND,
  TOOL_KIND_EDIT,
  TOOL_KIND_EXECUTE,
  TOOL_KIND_FETCH,
} from "../constants";
import { PERMISSION_OPTIONS, SessionScope } from "../events";
import { servedModelName } from "../servedModel";

import {
  DEFAULT_TOOL_TITLE,
  MESSAGE_ORDINAL_SEPARATOR,
  OpencodeV2Action,
  OpencodeV2EventType,
  TEXT_CONTENT_TYPE,
  V2_TOOL_KINDS,
} from "./constants";
import type { V2ModelRef } from "./client";
import type { OpencodeV2Event } from "./protocol";

export interface OpencodeV2EventMapper {
  map(event: OpencodeV2Event): AgentEvent[];
  scopeOf(event: OpencodeV2Event): SessionScope;
  beginTurn(): void;
}

type EventOfType<Type extends OpencodeV2Event["type"]> = Extract<
  OpencodeV2Event,
  { type: Type }
>;

interface PermissionDetails {
  readonly title: string;
  readonly kind: string;
  readonly rawInput?: unknown;
  readonly locations: string[];
}

function sessionOf(event: OpencodeV2Event): string | undefined {
  return event.type === OpencodeV2EventType.serverConnected
    ? undefined
    : event.data.sessionID;
}

function messageIdOf(assistantMessageID: string, ordinal: number): string {
  return `${assistantMessageID}${MESSAGE_ORDINAL_SEPARATOR}${String(ordinal)}`;
}

function outputOf(
  content: EventOfType<"session.tool.success">["data"]["content"],
): string | undefined {
  const texts = content
    .filter((item) => item.type === TEXT_CONTENT_TYPE)
    .flatMap((item) => (item.text === undefined ? [] : [item.text]));
  return texts.length === 0 ? undefined : texts.join("");
}

function editDetails(
  resources: readonly string[],
  cwd: string,
): PermissionDetails {
  const locations = [...new Set(resources.map((path) => resolve(cwd, path)))];
  const [filePath] = locations;
  return {
    title: TITLE_EDIT_FILE,
    kind: TOOL_KIND_EDIT,
    ...(filePath === undefined ? {} : { rawInput: { file_path: filePath } }),
    locations,
  };
}

const COMMAND_SEPARATOR = "\n";
const CALL_KEY_SEPARATOR = ":";

const CommandInputSchema = z.looseObject({
  command: z.string(),
  workdir: z.string().optional(),
});
type CommandInput = z.infer<typeof CommandInputSchema>;

function callKey(sessionID: string, callId: string): string {
  return `${sessionID}${CALL_KEY_SEPARATOR}${callId}`;
}

function knownCommandInput(
  data: EventOfType<"permission.asked">["data"],
  toolInputs: ReadonlyMap<string, unknown>,
): CommandInput | undefined {
  const callId = data.source?.id;
  const known =
    callId === undefined
      ? undefined
      : CommandInputSchema.safeParse(
          toolInputs.get(callKey(data.sessionID, callId)),
        );
  return known?.success === true ? known.data : undefined;
}

function shellCommand(
  data: EventOfType<"permission.asked">["data"],
  known: CommandInput | undefined,
): string | undefined {
  if (known !== undefined) {
    return known.command;
  }
  return data.resources.length === 0
    ? undefined
    : data.resources.join(COMMAND_SEPARATOR);
}

function permissionDetails(
  data: EventOfType<"permission.asked">["data"],
  cwd: string,
  toolInputs: ReadonlyMap<string, unknown>,
): PermissionDetails {
  switch (data.action) {
    case OpencodeV2Action.shell: {
      const known = knownCommandInput(data, toolInputs);
      const command = shellCommand(data, known);
      const workdir = known?.workdir;
      return {
        title: TITLE_RUN_COMMAND,
        kind: TOOL_KIND_EXECUTE,
        ...(command === undefined
          ? {}
          : {
              rawInput: {
                command,
                ...(workdir === undefined || workdir === ""
                  ? {}
                  : { cwd: resolve(cwd, workdir) }),
              },
            }),
        locations: [],
      };
    }
    case OpencodeV2Action.edit:
      return editDetails(data.resources, cwd);
    case OpencodeV2Action.webfetch:
      return { title: TITLE_FETCH_URL, kind: TOOL_KIND_FETCH, locations: [] };
    default:
      return { title: data.action, kind: DEFAULT_TOOL_KIND, locations: [] };
  }
}

function permissionRequest(
  event: EventOfType<"permission.asked">,
  cwd: string,
  toolInputs: ReadonlyMap<string, unknown>,
): Extract<AgentEvent, { type: "permission_request" }> {
  const { data } = event;
  return {
    type: "permission_request",
    requestId: data.id,
    toolCallId: data.source?.id ?? data.id,
    ...permissionDetails(data, cwd, toolInputs),
    options: PERMISSION_OPTIONS,
  };
}

function editInputPaths(input: unknown, cwd: string): readonly string[] {
  if (typeof input !== "object" || input === null) {
    return [];
  }
  const record = input as Record<string, unknown>;
  for (const key of ["filePath", "file_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      return [resolve(cwd, value)];
    }
  }
  return [];
}

function mapToolSuccess(
  event: EventOfType<"session.tool.success">,
  editPaths: ReadonlyMap<string, readonly string[]>,
): AgentEvent {
  const output = outputOf(event.data.content);
  const paths = editPaths.get(event.data.id) ?? [];
  const diffs = paths.map((path) => ({
    path,
    change: FileChange.modified,
    omitted: DiffOmission.notReported,
  }));
  return {
    type: "tool_call_update",
    toolCallId: event.data.id,
    status: "completed",
    ...(output === undefined ? {} : { output }),
    ...(diffs.length === 0 ? {} : { diffs }),
  };
}

function addEditPaths(
  editPaths: Map<string, readonly string[]>,
  toolCallId: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) {
    return;
  }
  const existing = editPaths.get(toolCallId) ?? [];
  editPaths.set(toolCallId, [...new Set([...existing, ...paths])]);
}

function mapToolCalledEvent(
  event: EventOfType<"session.tool.called">,
  cwd: string,
  names: ReadonlyMap<string, string>,
  editPaths: Map<string, readonly string[]>,
): AgentEvent {
  const name = names.get(event.data.id);
  const kind = V2_TOOL_KINDS[name ?? ""] ?? DEFAULT_TOOL_KIND;
  if (kind === TOOL_KIND_EDIT) {
    addEditPaths(
      editPaths,
      event.data.id,
      editInputPaths(event.data.input, cwd),
    );
  }
  return {
    type: "tool_call",
    toolCallId: event.data.id,
    title: name ?? DEFAULT_TOOL_TITLE,
    kind,
    status: "pending",
    rawInput: event.data.input,
  };
}

function createToolMapper(cwd: string): {
  map(event: OpencodeV2Event): AgentEvent[];
  recordEditPaths(toolCallId: string, paths: readonly string[]): void;
} {
  const names = new Map<string, string>();
  const editPaths = new Map<string, readonly string[]>();

  return {
    recordEditPaths(toolCallId, paths) {
      addEditPaths(editPaths, toolCallId, paths);
    },
    map(event) {
      switch (event.type) {
        case OpencodeV2EventType.toolInputStarted:
          names.set(event.data.id, event.data.name);
          return [];
        case OpencodeV2EventType.toolCalled:
          return [mapToolCalledEvent(event, cwd, names, editPaths)];
        case OpencodeV2EventType.toolProgress:
          return [
            {
              type: "tool_call_update",
              toolCallId: event.data.id,
              status: "in_progress",
            },
          ];
        case OpencodeV2EventType.toolSuccess:
          return [mapToolSuccess(event, editPaths)];
        case OpencodeV2EventType.toolFailed:
          return [
            {
              type: "tool_call_update",
              toolCallId: event.data.id,
              status: "failed",
              output: event.data.error.message,
            },
          ];
        default:
          return [];
      }
    },
  };
}

function createTextMapper(): (event: OpencodeV2Event) => AgentEvent[] {
  const texts = new Map<string, string>();

  function emit(messageId: string, full: string): AgentEvent[] {
    const previous = texts.get(messageId) ?? "";
    texts.set(messageId, full);
    const text = full.startsWith(previous) ? full.slice(previous.length) : full;
    return text === "" ? [] : [{ type: "text", messageId, text }];
  }

  return (event) => {
    switch (event.type) {
      case OpencodeV2EventType.textDelta: {
        const messageId = messageIdOf(
          event.data.assistantMessageID,
          event.data.ordinal,
        );
        return emit(
          messageId,
          `${texts.get(messageId) ?? ""}${event.data.delta}`,
        );
      }
      case OpencodeV2EventType.textEnded:
        return emit(
          messageIdOf(event.data.assistantMessageID, event.data.ordinal),
          event.data.text,
        );
      default:
        return [];
    }
  };
}

function createScopeTracker(sessionId: string): {
  scopeOf(event: OpencodeV2Event): SessionScope;
  observe(event: EventOfType<"session.created">): void;
} {
  const descendants = new Set<string>();
  return {
    scopeOf(event) {
      const owner = sessionOf(event);
      if (owner === undefined || owner === sessionId) {
        return SessionScope.own;
      }
      return descendants.has(owner)
        ? SessionScope.descendant
        : SessionScope.foreign;
    },
    observe({ data }) {
      const { parentID } = data;
      if (
        parentID !== null &&
        parentID !== undefined &&
        (parentID === sessionId || descendants.has(parentID))
      ) {
        descendants.add(data.sessionID);
      }
    },
  };
}

export function createV2EventMapper(
  sessionId: string,
  cwd: string,
  contextLimitOf: (model: V2ModelRef) => number | null = () => null,
): OpencodeV2EventMapper {
  const scopes = createScopeTracker(sessionId);
  const mapText = createTextMapper();
  const toolMapper = createToolMapper(cwd);
  const toolInputs = new Map<string, unknown>();
  let reportedModel: string | null = null;
  let lastModel: V2ModelRef | null = null;

  function mapOwn(event: OpencodeV2Event): AgentEvent[] {
    if (event.type === OpencodeV2EventType.stepEnded) {
      const { tokens } = event.data;
      const usedTokens =
        tokens.input +
        tokens.output +
        tokens.reasoning +
        tokens.cache.read +
        tokens.cache.write;
      const limitTokens = lastModel === null ? null : contextLimitOf(lastModel);
      const usage = contextUsageOf(usedTokens, limitTokens);
      return usage === null ? [] : [{ type: "context_usage", usage }];
    }
    if (event.type !== OpencodeV2EventType.stepStarted) {
      return [...mapText(event), ...toolMapper.map(event)];
    }
    const { id, providerID } = event.data.model;
    lastModel = { id, providerID: providerID ?? "" };
    const model = servedModelName(providerID, id);
    if (model === reportedModel) {
      return [];
    }
    reportedModel = model;
    return [{ type: "model", model }];
  }

  return {
    scopeOf: (event) => scopes.scopeOf(event),
    beginTurn() {
      reportedModel = null;
      toolInputs.clear();
    },
    map(event) {
      const scope = scopes.scopeOf(event);
      if (
        event.type === OpencodeV2EventType.toolCalled &&
        scope !== SessionScope.foreign
      ) {
        toolInputs.set(
          callKey(event.data.sessionID, event.data.id),
          event.data.input,
        );
      }
      if (event.type === OpencodeV2EventType.sessionCreated) {
        scopes.observe(event);
        return [];
      }
      if (event.type === OpencodeV2EventType.permissionAsked) {
        if (scope === SessionScope.foreign) {
          return [];
        }
        const request = permissionRequest(event, cwd, toolInputs);
        if (
          scope === SessionScope.own &&
          event.data.action === OpencodeV2Action.edit
        ) {
          toolMapper.recordEditPaths(request.toolCallId, request.locations);
        }
        return [request];
      }
      return scope === SessionScope.own ? mapOwn(event) : [];
    },
  };
}
