import type { AgentEvent, ToolCallStatus } from "../../domain/events";
import { DEFAULT_TOOL_KIND } from "../constants";

import {
  AUTH_FAILED_RESULT_ERROR,
  AUTH_MARKERS,
  AgyResultStatus,
  AgyStepState,
  AgyStepType,
  AgyToolName,
  FINISHED_REASON_INTERRUPTED,
  MESSAGE_ID_SEPARATOR,
  MODEL_FAILED_MESSAGE,
  NO_OUTPUT_DENIED_MESSAGE,
  QUOTA_MARKERS,
  TOOL_KIND_BY_NAME,
  TOOL_PARAM_COMMAND_LINE,
  TOOL_PARAM_PATH,
} from "./constants";
import type { AgyErrorLine, AgyResult, StepUpdate } from "./protocol";

export type TurnOutcome =
  | { readonly kind: "ended" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "quota"; readonly message: string }
  | { readonly kind: "auth"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

type FailureOutcome = Extract<
  TurnOutcome,
  { kind: "quota" | "auth" | "failed" }
>;

function stepId(step: StepUpdate, conversationId: string): string {
  return `${step.conversation_id ?? conversationId}${MESSAGE_ID_SEPARATOR}${String(step.step_index)}`;
}

function parameterOf(step: StepUpdate, key: string): string | null {
  const value = step.tool_info?.parameters?.[key];
  return typeof value === "string" ? value : null;
}

function toolName(step: StepUpdate): string {
  return step.tool_name ?? step.tool_info?.name ?? DEFAULT_TOOL_KIND;
}

function toolTitle(step: StepUpdate): string {
  return (
    parameterOf(step, TOOL_PARAM_COMMAND_LINE) ??
    parameterOf(step, TOOL_PARAM_PATH) ??
    toolName(step)
  );
}

function toolUpdate(
  toolCallId: string,
  status: ToolCallStatus,
  output: string | undefined,
): AgentEvent {
  return {
    type: "tool_call_update",
    toolCallId,
    status,
    ...(output === undefined ? {} : { output }),
  };
}

function toolStarted(toolCallId: string, step: StepUpdate): AgentEvent {
  return {
    type: "tool_call",
    toolCallId,
    title: toolTitle(step),
    kind: TOOL_KIND_BY_NAME.get(toolName(step)) ?? DEFAULT_TOOL_KIND,
    status: "in_progress",
    rawInput: step.tool_info?.parameters,
  };
}

function toolFinished(toolCallId: string, step: StepUpdate): AgentEvent {
  const output = step.tool_info?.output;
  if (output === undefined && toolName(step) === AgyToolName.runCommand) {
    return toolUpdate(toolCallId, "failed", NO_OUTPUT_DENIED_MESSAGE);
  }
  return toolUpdate(toolCallId, "completed", output);
}

function toolEvents(step: StepUpdate, conversationId: string): AgentEvent[] {
  const toolCallId = stepId(step, conversationId);
  switch (step.state) {
    case AgyStepState.active:
      return [toolStarted(toolCallId, step)];
    case AgyStepState.done:
      return [toolFinished(toolCallId, step)];
    case AgyStepState.error:
      return [toolUpdate(toolCallId, "failed", step.tool_info?.error?.message)];
    default:
      return [];
  }
}

function textEvents(step: StepUpdate, conversationId: string): AgentEvent[] {
  if (step.text_delta === undefined || step.text_delta === "") {
    return [];
  }
  return [
    {
      type: "text",
      messageId: stepId(step, conversationId),
      text: step.text_delta,
    },
  ];
}

export function stepEvents(
  step: StepUpdate,
  conversationId: string,
): AgentEvent[] {
  switch (step.step_type) {
    case AgyStepType.agentResponse:
      return textEvents(step, conversationId);
    case AgyStepType.tool:
      return toolEvents(step, conversationId);
    default:
      return [];
  }
}

function containsAny(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

function errorLineText(line: AgyErrorLine): string {
  return [line.short_error, line.status, line.error_code]
    .filter((part) => part !== undefined)
    .join(" ");
}

function newErrorText(
  error: string | undefined,
  previous: string | undefined,
): string {
  const text = error ?? "";
  if (previous === undefined || previous === "") {
    return text;
  }
  return text.startsWith(previous) ? text.slice(previous.length).trim() : text;
}

function classifyFailure(text: string): FailureOutcome {
  const message = text === "" ? MODEL_FAILED_MESSAGE : text;
  if (containsAny(text, QUOTA_MARKERS)) {
    return { kind: "quota", message };
  }
  if (containsAny(text, AUTH_MARKERS)) {
    return { kind: "auth", message };
  }
  return { kind: "failed", message };
}

export class TurnTracker {
  private failed = false;
  private sawResponse = false;
  private readonly errorLines: AgyErrorLine[] = [];
  private errorLineArrival = Promise.withResolvers<undefined>();

  get errorLineSeen(): Promise<undefined> {
    return this.errorLineArrival.promise;
  }

  observeStep(step: StepUpdate, conversationId: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (step.step_type === AgyStepType.errorMessage) {
      this.failed = true;
    }
    if (step.step_type === AgyStepType.agentResponse) {
      this.sawResponse = true;
      if (this.failed) {
        this.failed = false;
        this.clearErrorLines();
        events.push({ type: "api_retry" });
      }
    }
    return [...events, ...stepEvents(step, conversationId)];
  }

  observeErrorLine(line: AgyErrorLine): void {
    this.failed = true;
    this.errorLines.push(line);
    this.errorLineArrival.resolve(undefined);
  }

  private clearErrorLines(): void {
    if (this.errorLines.length > 0) {
      this.errorLineArrival = Promise.withResolvers<undefined>();
    }
    this.errorLines.length = 0;
  }

  awaitsErrorLine(result: AgyResult): boolean {
    return (
      result.finished_reason !== FINISHED_REASON_INTERRUPTED &&
      this.failed &&
      this.errorLines.length === 0 &&
      !this.resultReportsAuthFailure(result)
    );
  }

  failure(
    result?: AgyResult,
    previousResultError?: string,
  ): FailureOutcome | null {
    if (this.resultReportsAuthFailure(result)) {
      return {
        kind: "auth",
        message: result?.error ?? AUTH_FAILED_RESULT_ERROR,
      };
    }
    if (!this.failed) {
      return null;
    }
    const fromLines = this.errorLines.map(errorLineText).join(" ");
    return classifyFailure(
      fromLines === ""
        ? newErrorText(result?.error, previousResultError)
        : fromLines,
    );
  }

  settle(result: AgyResult, previousResultError?: string): TurnOutcome {
    if (result.finished_reason === FINISHED_REASON_INTERRUPTED) {
      return { kind: "cancelled" };
    }
    return this.failure(result, previousResultError) ?? { kind: "ended" };
  }

  private resultReportsAuthFailure(result: AgyResult | undefined): boolean {
    return (
      result?.status === AgyResultStatus.error &&
      !this.sawResponse &&
      (result.error ?? "").includes(AUTH_FAILED_RESULT_ERROR)
    );
  }
}
