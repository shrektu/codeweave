const HOME_MARKER = "~";
const WINDOWS_PLATFORM = "win32";

function isSeparator(char: string | undefined, windows: boolean): boolean {
  return char === "/" || (windows && char === "\\");
}

function trimTrailingSeparators(path: string, windows: boolean): string {
  let end = path.length;
  while (end > 1 && isSeparator(path[end - 1], windows)) {
    end -= 1;
  }
  return path.slice(0, end);
}

function withHomeMarker(
  path: string,
  home: string | null,
  windows: boolean,
): string {
  if (home === null) {
    return path;
  }
  const base = trimTrailingSeparators(home, windows);
  if (base.length <= 1) {
    return path;
  }
  const fold = (text: string): string => (windows ? text.toLowerCase() : text);
  if (fold(path.slice(0, base.length)) !== fold(base)) {
    return path;
  }
  const rest = path.slice(base.length);
  if (rest === "") {
    return HOME_MARKER;
  }
  return isSeparator(rest[0], windows) ? `${HOME_MARKER}${rest}` : path;
}

export function displayPath(
  path: string,
  home: string | null,
  platform: string,
): string {
  const windows = platform === WINDOWS_PLATFORM;
  return withHomeMarker(path, home, windows);
}

export interface PathParts {
  head: string;
  tail: string;
}

export function splitPath(path: string, platform: string): PathParts {
  const windows = platform === WINDOWS_PLATFORM;
  const trimmed = trimTrailingSeparators(path, windows);
  const lastSeparator = Math.max(
    trimmed.lastIndexOf("/"),
    windows ? trimmed.lastIndexOf("\\") : -1,
  );
  const cut = Math.max(lastSeparator, 0);
  return { head: trimmed.slice(0, cut), tail: trimmed.slice(cut) };
}
