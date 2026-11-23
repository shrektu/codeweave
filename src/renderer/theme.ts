import { useSyncExternalStore } from "react";

import { Appearance } from "../domain/types";

export type ResolvedTheme = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "codeweave.appearance";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(
  appearance: Appearance,
  prefersDark: boolean,
): ResolvedTheme {
  if (appearance === Appearance.system) {
    return prefersDark ? "dark" : "light";
  }
  return appearance;
}

function darkSchemeQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_SCHEME_QUERY)
    : undefined;
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = darkSchemeQuery();
  query?.addEventListener("change", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
  };
}

function ignoreSystemTheme(): () => void {
  return () => undefined;
}

export function systemPrefersDark(): boolean {
  return darkSchemeQuery()?.matches ?? true;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

function isAppearance(value: string | null): value is Appearance {
  return Object.values<string>(Appearance).includes(value ?? "");
}

export function readStoredAppearance(): Appearance | null {
  try {
    const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearance(stored) ? stored : null;
  } catch (error: unknown) {
    console.warn("Appearance could not be read", error);
    return null;
  }
}

export function storeAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch (error: unknown) {
    console.warn("Appearance could not be saved", error);
  }
}

export function useResolvedTheme(appearance: Appearance): ResolvedTheme {
  const prefersDark = useSyncExternalStore(
    appearance === Appearance.system
      ? subscribeToSystemTheme
      : ignoreSystemTheme,
    systemPrefersDark,
  );
  return resolveTheme(appearance, prefersDark);
}
