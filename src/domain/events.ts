export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

export type AgentEvent =
  | {
      readonly type: "text";
      readonly messageId?: string;
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly toolCallId: string;
      readonly title: string;
      readonly kind: string;
      readonly status: ToolCallStatus;
      readonly rawInput?: unknown;
    }
  | {
      readonly type: "tool_call_update";
      readonly toolCallId: string;
      readonly status?: ToolCallStatus;
      readonly output?: string;
    }
  | {
      readonly type: "permission_request";
      readonly requestId: string;
      readonly toolCallId: string;
      readonly title: string;
      readonly kind: string;
      readonly rawInput?: unknown;
      readonly locations: readonly string[];
      readonly options: readonly PermissionOption[];
    }
  | {
      readonly type: "rate_limit";
      readonly status: string;
      readonly resetsAt: unknown;
      readonly rateLimitType: unknown;
      readonly utilization: unknown;
    }
  | { readonly type: "api_retry" }
  | { readonly type: "turn_end"; readonly stopReason: string }
  | {
      readonly type: "turn_error";
      readonly errorKind: string | null;
      readonly rpcCode: number | null;
      readonly message: string;
    }
  | { readonly type: "process_exit" };
