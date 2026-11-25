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

function stripBase(
  path: string,
  baseDir: string | null,
  windows: boolean,
): string | null {
  if (baseDir === null) {
    return null;
  }
  const base = trimTrailingSeparators(baseDir, windows);
  if (base.length <= 1) {
    return null;
  }
  const fold = (text: string): string => (windows ? text.toLowerCase() : text);
  if (fold(path.slice(0, base.length)) !== fold(base)) {
    return null;
  }
  return path.slice(base.length);
}

function withHomeMarker(
  path: string,
  home: string | null,
  windows: boolean,
): string {
  const rest = stripBase(path, home, windows);
  if (rest === null) {
    return path;
  }
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

export function relativePath(
  path: string,
  cwd: string | null,
  platform = "",
): string {
  const windows = platform === WINDOWS_PLATFORM;
  const rest = stripBase(path, cwd, windows);
  if (rest === null) {
    return path;
  }
  if (rest === "") {
    return ".";
  }
  return isSeparator(rest[0], windows) ? rest.slice(1) : path;
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
