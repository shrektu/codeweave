const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export function isWebUrl(value: string): boolean {
  return URL.canParse(value) && WEB_PROTOCOLS.has(new URL(value).protocol);
}
