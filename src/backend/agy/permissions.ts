import { PermissionProfile } from "../../domain/types";

import { AgyMode, AgyToolPermission } from "./constants";

export interface AgySettings {
  readonly toolPermission: AgyToolPermission;
  readonly useG1Credits: false;
}

export interface AgyLaunchPermissions {
  readonly settings: AgySettings;
  readonly mode: AgyMode | null;
}

export function agySettingsFor(
  profile: PermissionProfile,
): AgyLaunchPermissions {
  return {
    settings: {
      toolPermission: AgyToolPermission.alwaysProceed,
      useG1Credits: false,
    },
    mode: profile === PermissionProfile.plan ? AgyMode.plan : null,
  };
}
