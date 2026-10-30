import { MIN_SECRET_LENGTH } from "./constants";

export interface SecretEntry {
  readonly value: string;
  readonly label: string;
}

export interface SecretMasker {
  readonly maxLength: number;
  mask(text: string): string;
  maskDeep<T>(value: T): T;
}

export interface StreamingMasker {
  push(key: string, delta: string): string;
  flush(key: string): string;
  flushAll(): readonly { readonly key: string; readonly text: string }[];
}

function replacementFor(label: string): string {
  return `[redacted:${label}]`;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function usableEntries(entries: readonly SecretEntry[]): SecretEntry[] {
  const seen = new Set<string>();
  return entries
    .filter(({ value }) => value.length >= MIN_SECRET_LENGTH)
    .toSorted((left, right) => right.value.length - left.value.length)
    .filter(({ value }) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

export function createSecretMasker(
  entries: readonly SecretEntry[],
): SecretMasker {
  const usable = usableEntries(entries);
  const mask = (text: string): string =>
    usable.reduce(
      (masked, { value, label }) =>
        masked.replaceAll(value, () => replacementFor(label)),
      text,
    );
  const maskDeep = <T>(value: T): T => maskUnknown(value, mask) as T;
  return {
    maxLength: Math.max(0, ...usable.map(({ value }) => value.length)),
    mask,
    maskDeep,
  };
}

function maskUnknown(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") {
    return mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => maskUnknown(item, mask));
  }
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        maskUnknown(item, mask),
      ]),
    );
  }
  return value;
}

export function createStreamingMasker(
  source: () => SecretMasker,
): StreamingMasker {
  const held = new Map<string, string>();
  const settle = (key: string, text: string): string => {
    const masker = source();
    const masked = masker.mask(text);
    const keep = Math.max(0, masker.maxLength - 1);
    const cut = masked.length - keep;
    held.set(key, masked.slice(Math.max(0, cut)));
    return cut > 0 ? masked.slice(0, cut) : "";
  };
  const flush = (key: string): string => {
    const text = source().mask(held.get(key) ?? "");
    held.delete(key);
    return text;
  };
  return {
    push: (key, delta) => settle(key, (held.get(key) ?? "") + delta),
    flush,
    flushAll: () =>
      [...held.keys()]
        .map((key) => ({ key, text: flush(key) }))
        .filter(({ text }) => text !== ""),
  };
}
