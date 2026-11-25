import type {
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";

import {
  ERROR_KIND_AUTH_REQUIRED,
  RPC_CODE_AUTH_REJECTED,
  UNKNOWN_ERROR,
} from "../../domain/constants";
import { contextUsageOf } from "../../domain/contextUsage";
import {
  DiffOmission,
  FileChange,
  type AgentEvent,
  type FileDiff,
  type ToolCallStatus,
} from "../../domain/events";
import {
  CLAUDE_MODEL_META_KEY,
  CLAUDE_RATE_LIMIT_META_KEY,
  DEFAULT_MODEL_ALIAS,
  DEFAULT_TOOL_KIND,
  DEFAULT_TOOL_STATUS,
  DIFF_MAX_FILE_BYTES,
  MODEL_CONFIG_ID,
  TOOL_OUTPUT_SEPARATOR,
  UNKNOWN_RATE_LIMIT_STATUS,
} from "../constants";
import {
  computeFileDiff,
  computePositionedFileDiff,
  type PositionedDiffInput,
} from "../fileDiff";
import { SnapshotKind, type FileSnapshot } from "../fileSnapshot";

type SessionUpdate = SessionNotification["update"];
type SessionConfigSelect = Extract<SessionConfigOption, { type: "select" }>;
type TurnError = Extract<AgentEvent, { type: "turn_error" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fieldOf(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function mapMessageChunk(
  update: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>,
): AgentEvent[] {
  if (update.content.type !== "text") {
    return [];
  }
  const messageId = update.messageId;
  return [
    {
      type: "text",
      text: update.content.text,
      ...(typeof messageId === "string" ? { messageId } : {}),
    },
  ];
}

function textSnapshot(text: string): FileSnapshot {
  if (Buffer.byteLength(text, "utf8") > DIFF_MAX_FILE_BYTES) {
    return { kind: SnapshotKind.tooLarge };
  }
  if (text.includes("\0")) {
    return { kind: SnapshotKind.binary };
  }
  return { kind: SnapshotKind.text, text };
}

type DiffContentItem = Extract<ToolCallContent, { type: "diff" }>;

const TOOL_KIND_EDIT = "edit";

function snapshotsOf(item: DiffContentItem): {
  before: FileSnapshot;
  after: FileSnapshot;
} {
  return {
    before:
      item.oldText == null
        ? { kind: SnapshotKind.missing }
        : textSnapshot(item.oldText),
    after: textSnapshot(item.newText),
  };
}

function diffsOf(
  content: readonly ToolCallContent[] | null | undefined,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  for (const item of content ?? []) {
    if (item.type !== "diff") {
      continue;
    }
    const { before, after } = snapshotsOf(item);
    const diff = computeFileDiff(item.path, before, after);
    if (diff !== null) {
      diffs.push(diff);
    }
  }
  return diffs;
}

function positionedDiffsOf(
  diffItems: readonly DiffContentItem[],
  locations: readonly {
    readonly path: string;
    readonly line?: number | null;
  }[],
): FileDiff[] {
  const grouped = new Map<string, PositionedDiffInput[]>();
  const unpositioned: FileDiff[] = [];
  for (const [index, item] of diffItems.entries()) {
    const line = locations[index]?.line;
    const { before, after } = snapshotsOf(item);
    if (typeof line === "number") {
      const list = grouped.get(item.path) ?? [];
      list.push({ before, after, line });
      grouped.set(item.path, list);
    } else {
      const diff = computeFileDiff(item.path, before, after);
      if (diff !== null) {
        unpositioned.push(diff);
      }
    }
  }
  const positioned: FileDiff[] = [];
  for (const [path, inputs] of grouped) {
    const diff = computePositionedFileDiff(path, inputs);
    if (diff !== null) {
      positioned.push(diff);
    }
  }
  return [...positioned, ...unpositioned];
}

function updateDiffsOf(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
  kind: string,
  locations: readonly ToolCallLocation[],
): readonly FileDiff[] | undefined {
  const content = update.content ?? [];
  const diffItems = content.filter(
    (item): item is DiffContentItem => item.type === "diff",
  );
  if (diffItems.length > 0) {
    return positionedDiffsOf(diffItems, locations);
  }
  if (content.length > 0 && kind === TOOL_KIND_EDIT) {
    const tooLargePaths = locations
      .filter((loc) => loc.line == null)
      .map((loc) => loc.path);
    if (tooLargePaths.length > 0) {
      return tooLargePaths.map((path) => ({
        path,
        change: FileChange.modified,
        omitted: DiffOmission.tooLarge,
      }));
    }
  }
  return undefined;
}

function mapToolCall(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
): AgentEvent[] {
  const diffs = diffsOf(update.content);
  const callEvent: AgentEvent = {
    type: "tool_call",
    toolCallId: update.toolCallId,
    title: update.title,
    kind: update.kind ?? DEFAULT_TOOL_KIND,
    status: update.status ?? DEFAULT_TOOL_STATUS,
    ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
  };
  return diffs.length === 0
    ? [callEvent]
    : [
        callEvent,
        {
          type: "tool_call_update",
          toolCallId: update.toolCallId,
          diffs,
        },
      ];
}

const FENCED_BLOCK = /^(`{3,})[^\n`]*\r?\n(?:([\s\S]*?)\r?\n)?\1[ \t]*$/;
const LINE_BREAK = /\r?\n/;

function unfence(text: string): string {
  const match = FENCED_BLOCK.exec(text.trim());
  const fence = match?.[1];
  if (fence === undefined) {
    return text;
  }
  const inner = match?.[2] ?? "";
  const closing = new RegExp(`^ {0,3}\`{${fence.length.toString()},}[ \\t]*$`);
  return inner.split(LINE_BREAK).some((line) => closing.test(line))
    ? text
    : inner;
}

function textOf(content: ToolCallContent): string[] {
  return content.type === "content" && content.content.type === "text"
    ? [unfence(content.content.text)]
    : [];
}

function outputOf(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): string | undefined {
  const texts = (update.content ?? []).flatMap(textOf);
  if (texts.length > 0) {
    return texts.join(TOOL_OUTPUT_SEPARATOR);
  }
  return typeof update.rawOutput === "string" ? update.rawOutput : undefined;
}

function mapToolCallUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
  kind: string,
  locations: readonly ToolCallLocation[],
): AgentEvent[] {
  const status: ToolCallStatus | null | undefined = update.status;
  const output = outputOf(update);
  const diffs = updateDiffsOf(update, kind, locations);
  return [
    {
      type: "tool_call_update",
      toolCallId: update.toolCallId,
      ...(update.title == null ? {} : { title: update.title }),
      ...(update.kind == null ? {} : { kind: update.kind }),
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      ...(status == null ? {} : { status }),
      ...(output === undefined ? {} : { output }),
      ...(diffs === undefined ? {} : { diffs }),
    },
  ];
}

function selectOf(
  options: readonly SessionConfigOption[] | null | undefined,
): SessionConfigSelect | null {
  const option = options?.find((item) => item.id === MODEL_CONFIG_ID);
  return option?.type === "select" ? option : null;
}

export function modelValueOf(
  options: readonly SessionConfigOption[] | null | undefined,
): string | null {
  return selectOf(options)?.currentValue ?? null;
}

export function modelOf(
  options: readonly SessionConfigOption[] | null | undefined,
): string | null {
  const select = selectOf(options);
  if (select === null) {
    return null;
  }
  if (select.currentValue !== DEFAULT_MODEL_ALIAS) {
    return select.currentValue;
  }
  const alias = select.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .find((entry) => entry.value === DEFAULT_MODEL_ALIAS);
  const resolved = alias?.description ?? "";
  return resolved === "" ? null : resolved;
}

function mapModel(model: unknown): AgentEvent[] {
  return typeof model === "string" && model !== ""
    ? [{ type: "model", model }]
    : [];
}

function mapRateLimit(limit: unknown): AgentEvent[] {
  if (!isRecord(limit)) {
    return [];
  }
  return [
    {
      type: "rate_limit",
      status:
        typeof limit.status === "string"
          ? limit.status
          : UNKNOWN_RATE_LIMIT_STATUS,
      resetsAt: limit.resetsAt,
      rateLimitType: limit.rateLimitType,
      utilization: limit.utilization,
    },
  ];
}

function mapContextUsage(
  update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>,
): AgentEvent[] {
  const usage = contextUsageOf(update.used, update.size);
  return usage === null ? [] : [{ type: "context_usage", usage }];
}

function mapUsageUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>,
): AgentEvent[] {
  return [
    ...mapRateLimit(update._meta?.[CLAUDE_RATE_LIMIT_META_KEY]),
    ...mapModel(update._meta?.[CLAUDE_MODEL_META_KEY]),
    ...mapContextUsage(update),
  ];
}

export function createAcpEventMapper(): {
  map(update: SessionUpdate): AgentEvent[];
} {
  const toolKinds = new Map<string, string>();
  const toolLocations = new Map<string, readonly ToolCallLocation[]>();
  return {
    map(update) {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          return mapMessageChunk(update);
        case "tool_call":
          toolKinds.set(update.toolCallId, update.kind ?? DEFAULT_TOOL_KIND);
          if (update.locations != null) {
            toolLocations.set(update.toolCallId, update.locations);
          }
          return mapToolCall(update);
        case "tool_call_update": {
          if (update.kind != null) {
            toolKinds.set(update.toolCallId, update.kind);
          }
          if (update.locations != null) {
            toolLocations.set(update.toolCallId, update.locations);
          }
          const kind =
            update.kind ??
            toolKinds.get(update.toolCallId) ??
            DEFAULT_TOOL_KIND;
          const locations =
            update.locations ?? toolLocations.get(update.toolCallId) ?? [];
          return mapToolCallUpdate(update, kind, locations);
        }
        case "usage_update":
          return mapUsageUpdate(update);
        case "config_option_update":
          return mapModel(modelOf(update.configOptions));
        default:
          return [];
      }
    },
  };
}

export function mapSessionUpdate(update: SessionUpdate): AgentEvent[] {
  return createAcpEventMapper().map(update);
}

export function mapPromptError(error: unknown): TurnError {
  const code = fieldOf(error, "code");
  const errorKind = fieldOf(fieldOf(error, "data"), "errorKind");
  const message = fieldOf(error, "message");
  return {
    type: "turn_error",
    errorKind: typeof errorKind === "string" ? errorKind : null,
    rpcCode: typeof code === "number" ? code : null,
    message: typeof message === "string" ? message : UNKNOWN_ERROR,
  };
}

export function isAuthError(error: unknown): boolean {
  return (
    fieldOf(error, "code") === RPC_CODE_AUTH_REJECTED ||
    fieldOf(fieldOf(error, "data"), "errorKind") === ERROR_KIND_AUTH_REQUIRED
  );
}
