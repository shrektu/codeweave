import { isWebUrl } from "../shared/links";

export function externalLinkOf(value: unknown): string | null {
  if (typeof value !== "string" || !isWebUrl(value)) {
    return null;
  }
  return new URL(value).href;
}

export async function openFromApp(
  trusted: boolean,
  value: unknown,
  open: (url: string) => Promise<void>,
): Promise<void> {
  const link = externalLinkOf(value);
  if (trusted && link !== null) {
    await open(link);
  }
}
