import type { ApiAuth, ApiProviderId } from "./apiProviders";

export const ProviderId = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
} as const;
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];

export const LimitAvailability = {
  pending: "pending",
  reported: "reported",
  unsupported: "unsupported",
  failed: "failed",
} as const;
export type LimitAvailability =
  (typeof LimitAvailability)[keyof typeof LimitAvailability];

export const PermissionProfile = {
  bypass: "bypass",
  unattended: "unattended",
  acceptEdits: "accept-edits",
  ask: "ask",
  plan: "plan",
} as const;
export type PermissionProfile =
  (typeof PermissionProfile)[keyof typeof PermissionProfile];

export const EffectLevel = {
  auto: "auto",
  low: "low",
  full: "full",
} as const;
export type EffectLevel = (typeof EffectLevel)[keyof typeof EffectLevel];

export const Appearance = {
  system: "system",
  light: "light",
  dark: "dark",
} as const;
export type Appearance = (typeof Appearance)[keyof typeof Appearance];

export const UpdateChannel = {
  stable: "stable",
  beta: "beta",
} as const;
export type UpdateChannel = (typeof UpdateChannel)[keyof typeof UpdateChannel];

export const FlowPlacement = {
  inPlace: "in_place",
  worktree: "worktree",
} as const;
export type FlowPlacement = (typeof FlowPlacement)[keyof typeof FlowPlacement];

export const DefinitionSource = {
  project: "project",
  library: "library",
} as const;
export type DefinitionSource =
  (typeof DefinitionSource)[keyof typeof DefinitionSource];

export const FlowRunOrigin = {
  user: "user",
  orchestrator: "orchestrator",
} as const;
export type FlowRunOrigin = (typeof FlowRunOrigin)[keyof typeof FlowRunOrigin];

export const MergeStatus = {
  merged: "merged",
  conflict: "conflict",
} as const;
export type MergeStatus = (typeof MergeStatus)[keyof typeof MergeStatus];

export type MergeOutcome =
  | { readonly status: typeof MergeStatus.merged; readonly commit: string }
  | {
      readonly status: typeof MergeStatus.conflict;
      readonly files: readonly string[];
    };

export const TerminalStatus = {
  running: "running",
  exited: "exited",
} as const;
export type TerminalStatus =
  (typeof TerminalStatus)[keyof typeof TerminalStatus];

export const EdgeKind = {
  waitsFor: "waits_for",
  handsOffTo: "hands_off_to",
  reviews: "reviews",
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export type EpochSeconds = number;
export type EpochMillis = number;

export interface ApiAccount {
  readonly provider: ApiProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly rotation: boolean;
  readonly auth: ApiAuth;
}

export interface Account {
  readonly id: string;
  readonly provider: ProviderId;
  readonly label: string;
  readonly configDir: string;
  readonly order: number;
  readonly api?: ApiAccount | undefined;
}

export const SwitchReason = {
  rateLimit: "rate_limit",
  needsLogin: "needs_login",
  resetReached: "reset_reached",
} as const;
export type SwitchReason = (typeof SwitchReason)[keyof typeof SwitchReason];

export interface SwitchLogEntry {
  readonly at: EpochMillis;
  readonly sessionId: string;
  readonly from: string;
  readonly to: string | null;
  readonly reason: SwitchReason;
  readonly resetsAt: EpochSeconds | null;
  readonly contextPackageChars: number;
}

export type WorktreeState =
  | { readonly isRepo: false; readonly cwd: string }
  | {
      readonly isRepo: true;
      readonly root: string;
      readonly porcelain: string;
      readonly diffStat: string;
    };
