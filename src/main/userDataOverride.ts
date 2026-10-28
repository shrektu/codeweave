export const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";

export interface UserDataOverrideInputs {
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export function resolveUserDataOverride({
  isPackaged,
  env,
}: UserDataOverrideInputs): string | null {
  if (isPackaged) {
    return null;
  }
  const dir = env[USER_DATA_DIR_ENV];
  return dir === undefined || dir === "" ? null : dir;
}
