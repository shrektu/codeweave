import { PermissionProfile } from "../domain/types";

export interface ProfileOption {
  value: PermissionProfile;
  label: string;
  description: string;
}

export const PROFILE_OPTIONS: readonly ProfileOption[] = [
  {
    value: PermissionProfile.bypass,
    label: "Bypass",
    description: "The agent runs every tool without asking.",
  },
  {
    value: PermissionProfile.unattended,
    label: "Unattended",
    description:
      "Allows reads, edits and commands inside the project; blocks dangerous commands.",
  },
  {
    value: PermissionProfile.acceptEdits,
    label: "Accept edits",
    description: "Allows reads and edits; asks before running commands.",
  },
  {
    value: PermissionProfile.ask,
    label: "Ask",
    description: "Asks before every edit and command.",
  },
  {
    value: PermissionProfile.plan,
    label: "Plan",
    description: "Read-only: edits and commands are denied.",
  },
];
