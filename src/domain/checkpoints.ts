export const RestoreAction = {
  write: "write",
  delete: "delete",
  none: "none",
} as const;
export type RestoreAction = (typeof RestoreAction)[keyof typeof RestoreAction];

export const RestoreSkipReason = {
  conflict: "conflict",
  unverifiable: "unverifiable",
  binary: "binary",
  tooLarge: "too_large",
  notReported: "not_reported",
  patchMismatch: "patch_mismatch",
  evicted: "evicted",
  protected: "protected",
} as const;
export type RestoreSkipReason =
  (typeof RestoreSkipReason)[keyof typeof RestoreSkipReason];

export const OVERWRITABLE_SKIP_REASONS: readonly RestoreSkipReason[] = [
  RestoreSkipReason.conflict,
  RestoreSkipReason.unverifiable,
];

export const RewindMode = {
  conversationAndFiles: "conversation_and_files",
  conversation: "conversation",
  files: "files",
} as const;
export type RewindMode = (typeof RewindMode)[keyof typeof RewindMode];
