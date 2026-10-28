const FILE_PROTOCOL = "file:";
const OPAQUE_ORIGIN = "null";

export function isAppUrl(url: string, entry: string): boolean {
  if (!URL.canParse(url) || !URL.canParse(entry)) {
    return false;
  }
  const target = new URL(url);
  const base = new URL(entry);
  if (base.protocol === FILE_PROTOCOL) {
    return (
      target.protocol === FILE_PROTOCOL &&
      target.host === base.host &&
      target.pathname === base.pathname
    );
  }
  return target.origin !== OPAQUE_ORIGIN && target.origin === base.origin;
}
