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
  readonly cwd: string;
  readonly provider: ProviderId;
  readonly accounts: readonly Account[];
  readonly profile: PermissionProfile;
  readonly phase: RotationPhase;
  readonly state: SessionState;
  readonly limits: readonly LimitView[];
  readonly turnInFlight: boolean;
  readonly flowRef: FlowRef | null;
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
  return {
    id: input.id,
    cwd: input.cwd,
    provider: input.provider,
    profile: input.profile,
    phase: input.phase,
    activeAccountId,
    activeProvider:
      input.accounts.find((account) => account.id === activeAccountId)
        ?.provider ?? input.provider,
    messages: state.messages.map((message) => ({ ...message })),
    toolCalls: state.toolCalls.map(toToolCallView),
    permissions: pendingPermissions(input),
    limits: [...input.limits],
    lastTurn: state.lastTurn,
    turnInFlight: input.turnInFlight,
    flowRef: input.flowRef,
  };
}
