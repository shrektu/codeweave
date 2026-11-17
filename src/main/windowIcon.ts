import { join } from "node:path";

const PACKAGED_ICON = "icon.png";
const DEV_ICON_DIR = "build";
const DEV_ICON_SUBDIR = "icons";
const DEV_ICON = "512x512.png";

export function linuxWindowIcon(
  isPackaged: boolean,
  resourcesPath: string,
  appPath: string,
): string {
  return isPackaged
    ? join(resourcesPath, PACKAGED_ICON)
    : join(appPath, DEV_ICON_DIR, DEV_ICON_SUBDIR, DEV_ICON);
}
