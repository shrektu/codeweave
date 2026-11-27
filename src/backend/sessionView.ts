import { PROVIDER_IMAGE_INPUT } from "../domain/attachments";
import type { RotationPhase } from "../domain/rotation";
import type { SessionState, ToolCallEntry } from "../domain/sessionReducer";
import type { Account, PermissionProfile, ProviderId } from "../domain/types";
import type {
  FlowRef,
  LimitView,
  PermissionView,
  SessionView,
  ToolCallView,
} from "../shared/views";

export interface SessionViewInput {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd: string;
  readonly explicitFolder: boolean;
  readonly provider: ProviderId;
  readonly accounts: readonly Account[];
  readonly profile: PermissionProfile;
  readonly phase: RotationPhase;
  readonly state: SessionState;
  readonly limits: readonly LimitView[];
  readonly turnInFlight: boolean;
  readonly canCompact: boolean;
  readonly flowRef: FlowRef | null;
  readonly orchestrate: boolean;
  readonly hiddenRequestIds: ReadonlySet<string>;
}

function activeAccountOf(phase: RotationPhase): string | null {
  switch (phase.phase) {
    case "running":
    case "waiting":
      return phase.accountId;
    case "switching":
      return phase.from;
    case "failed":
      return phase.runningAccountId;
    case "halted":
    case "stopped":
      return null;
  }
}

function toToolCallView(tool: ToolCallEntry): ToolCallView {
  const { diffs, ...rest } = tool;
  return {
    ...rest,
    ...(diffs === undefined
      ? {}
      : { diffs: diffs.map((diff) => ({ ...diff })) }),
  };
}

function pendingPermissions(input: SessionViewInput): PermissionView[] {
  return input.state.permissions.flatMap((record) =>
    record.state === "pending" && !input.hiddenRequestIds.has(record.requestId)
      ? [
          {
            requestId: record.requestId,
            toolCallId: record.toolCallId,
            title: record.title,
            ...(record.command === undefined
              ? {}
              : { command: record.command }),
            seq: record.seq,
            options: record.options.map((option) => ({ ...option })),
          },
        ]
      : [],
  );
}

export function toSessionView(input: SessionViewInput): SessionView {
  const { state } = input;
  const activeAccountId = activeAccountOf(input.phase);
  const activeProvider =
    input.accounts.find((account) => account.id === activeAccountId)
      ?.provider ?? input.provider;
  return {
    id: input.id,
    createdAt: input.createdAt,
    cwd: input.cwd,
    explicitFolder: input.explicitFolder,
    provider: input.provider,
    profile: input.profile,
    phase: input.phase,
    activeAccountId,
    activeProvider,
    messages: state.messages.map((message) => ({ ...message })),
    toolCalls: state.toolCalls.map(toToolCallView),
    permissions: pendingPermissions(input),
    limits: [...input.limits],
    lastTurn: state.lastTurn,
    turnInFlight: input.turnInFlight,
    flowRef: input.flowRef,
    currentModel: state.currentModel,
    contextUsage:
      state.contextUsage === null ? null : { ...state.contextUsage },
    usage: state.usage,
    turns: state.turns.map((turn) => ({ ...turn })),
    orchestrate: input.orchestrate,
    imageInput: PROVIDER_IMAGE_INPUT[activeProvider],
    canCompact: input.canCompact,
    prompts: state.prompts.map((prompt) => ({
      ...prompt,
      attachments: [...prompt.attachments],
    })),
  };
}
