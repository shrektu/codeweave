import type { ITerminalOptions, ITheme } from "@xterm/xterm";

import type { EffectLevel } from "../effects";

export type TerminalRenderer = "webgl" | "dom";

export interface RendererInputs {
  gpuAccelerated: boolean;
  webglFailed: boolean;
}

export const TERMINAL_FONT_FAMILY = "JetBrains Mono, monospace";
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_SCROLLBACK_LOW = 2000;
export const TERMINAL_SCROLLBACK_FULL = 10_000;

const THEME_TOKENS = {
  background: "--terminal-bg",
  foreground: "--terminal-fg",
  cursor: "--terminal-cursor",
  selectionBackground: "--terminal-selection",
} as const;

export function chooseTerminalRenderer({
  gpuAccelerated,
  webglFailed,
}: RendererInputs): TerminalRenderer {
  return gpuAccelerated && !webglFailed ? "webgl" : "dom";
}

export function readTerminalTheme(
  element: HTMLElement = document.documentElement,
): ITheme {
  const style = getComputedStyle(element);
  return {
    background: style.getPropertyValue(THEME_TOKENS.background).trim(),
    foreground: style.getPropertyValue(THEME_TOKENS.foreground).trim(),
    cursor: style.getPropertyValue(THEME_TOKENS.cursor).trim(),
    selectionBackground: style
      .getPropertyValue(THEME_TOKENS.selectionBackground)
      .trim(),
  };
}

export function levelOptions(
  level: EffectLevel,
): Required<Pick<ITerminalOptions, "scrollback" | "cursorBlink">> {
  const full = level === "full";
  return {
    scrollback: full ? TERMINAL_SCROLLBACK_FULL : TERMINAL_SCROLLBACK_LOW,
    cursorBlink: full,
  };
}

export function terminalOptions(
  level: EffectLevel,
  theme: ITheme,
): ITerminalOptions {
  return {
    ...levelOptions(level),
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    allowProposedApi: false,
    smoothScrollDuration: 0,
    theme,
  };
}
