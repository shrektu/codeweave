import type { LimitWindow } from "./limitWindows";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export const FileChange = {
  created: "created",
  modified: "modified",
  deleted: "deleted",
} as const;
export type FileChange = (typeof FileChange)[keyof typeof FileChange];

export const DiffOmission = {
  binary: "binary",
  tooLarge: "too_large",
  notReported: "not_reported",
} as const;
export type DiffOmission = (typeof DiffOmission)[keyof typeof DiffOmission];

export type FileDiff =
  | {
      readonly path: string;
      readonly change: FileChange;
      readonly patch: string;
    }
  | {
      readonly path: string;
      readonly change: FileChange;
      readonly omitted: DiffOmission;
    };

export interface ContextUsage {
  readonly usedTokens: number;
  readonly limitTokens: number | null;
}

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
      readonly title?: string;
      readonly kind?: string;
      readonly rawInput?: unknown;
      readonly status?: ToolCallStatus;
      readonly output?: string;
      readonly diffs?: readonly FileDiff[];
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
      readonly type: "permission_settled";
      readonly requestId: string;
      readonly optionId: string;
    }
  | {
      readonly type: "rate_limit";
      readonly status: string;
      readonly resetsAt: unknown;
      readonly rateLimitType: unknown;
      readonly utilization: unknown;
      readonly windows?: readonly LimitWindow[];
    }
  | { readonly type: "api_retry" }
  | { readonly type: "model"; readonly model: string }
  | { readonly type: "context_usage"; readonly usage: ContextUsage }
  | { readonly type: "turn_end"; readonly stopReason: string }
  | {
      readonly type: "turn_error";
      readonly errorKind: string | null;
      readonly rpcCode: number | null;
      readonly message: string;
    }
  | { readonly type: "process_exit" };
