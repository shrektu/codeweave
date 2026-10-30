import {
  MIGRATION_COMMANDS,
  OPAQUE_COMMANDS,
  PRIVILEGE_COMMANDS,
  PROTECTED_BRANCHES,
} from "../../domain/permissionRules";
import { PermissionProfile } from "../../domain/types";

import {
  AgyMode,
  AgyToolPermission,
  GIT_PUSH_FORCE_FLAGS,
  GIT_PUSH_TOKENS,
  GIT_REMOTE_ORIGIN,
  RM_COMMAND,
  RM_DANGER_FLAGS,
  WRITE_FILE_DENY_RULE,
} from "./constants";

export interface AgySettings {
  readonly toolPermission: AgyToolPermission;
  readonly useG1Credits: false;
  readonly permissions?: { readonly deny: readonly string[] };
}

export interface AgyLaunchPermissions {
  readonly settings: AgySettings;
  readonly mode: AgyMode | null;
}

function commandRule(...tokens: readonly string[]): string {
  return `command(${tokens.join(" ")})`;
}

const DANGER_RULES: readonly string[] = [
  ...PRIVILEGE_COMMANDS.map((command) => commandRule(command)),
  ...MIGRATION_COMMANDS.map((tokens) => commandRule(...tokens)),
  ...RM_DANGER_FLAGS.map((flag) => commandRule(RM_COMMAND, flag)),
  ...GIT_PUSH_FORCE_FLAGS.map((flag) => commandRule(...GIT_PUSH_TOKENS, flag)),
  ...PROTECTED_BRANCHES.map((branch) =>
    commandRule(...GIT_PUSH_TOKENS, GIT_REMOTE_ORIGIN, branch),
  ),
];

const OPAQUE_RULES: readonly string[] = OPAQUE_COMMANDS.map((command) =>
  commandRule(command),
);

const READ_ONLY_RULES: readonly string[] = [
  ...DANGER_RULES,
  WRITE_FILE_DENY_RULE,
];

function withDeny(
  toolPermission: AgyToolPermission,
  deny: readonly string[],
  mode: AgyMode | null,
): AgyLaunchPermissions {
  return {
    settings: { toolPermission, useG1Credits: false, permissions: { deny } },
    mode,
  };
}

export function agySettingsFor(
  profile: PermissionProfile,
): AgyLaunchPermissions {
  switch (profile) {
    case PermissionProfile.bypass:
      return {
        settings: {
          toolPermission: AgyToolPermission.alwaysProceed,
          useG1Credits: false,
        },
        mode: null,
      };
    case PermissionProfile.unattended:
      return withDeny(
        AgyToolPermission.alwaysProceed,
        [...DANGER_RULES, ...OPAQUE_RULES],
        null,
      );
    case PermissionProfile.acceptEdits:
      return withDeny(
        AgyToolPermission.requestReview,
        DANGER_RULES,
        AgyMode.acceptEdits,
      );
    case PermissionProfile.ask:
      return withDeny(AgyToolPermission.requestReview, READ_ONLY_RULES, null);
    case PermissionProfile.plan:
      return withDeny(
        AgyToolPermission.requestReview,
        READ_ONLY_RULES,
        AgyMode.plan,
      );
  }
}
