import { afterEach, expect, it } from "vitest";

import {
  chooseTerminalRenderer,
  readTerminalTheme,
  terminalOptions,
} from "./options";

const THEME = { background: "#000000" };

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

it("terminal_options_for_low_level_are_light", () => {
  expect(terminalOptions("low", THEME)).toEqual({
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 13,
    allowProposedApi: false,
    scrollback: 2000,
    cursorBlink: false,
    smoothScrollDuration: 0,
    theme: THEME,
  });
});

it("terminal_options_for_full_level_blink_and_keep_more_history", () => {
  const options = terminalOptions("full", THEME);

  expect(options.scrollback).toBe(10_000);
  expect(options.cursorBlink).toBe(true);
  expect(options.fontSize).toBe(13);
});

it("terminal_renderer_is_webgl_only_for_a_gpu_without_failure", () => {
  expect(
    chooseTerminalRenderer({ gpuAccelerated: true, webglFailed: false }),
  ).toBe("webgl");
  expect(
    chooseTerminalRenderer({ gpuAccelerated: true, webglFailed: true }),
  ).toBe("dom");
  expect(
    chooseTerminalRenderer({ gpuAccelerated: false, webglFailed: false }),
  ).toBe("dom");
  expect(
    chooseTerminalRenderer({ gpuAccelerated: false, webglFailed: true }),
  ).toBe("dom");
});

it("terminal_theme_is_read_from_css_tokens", () => {
  const style = document.documentElement.style;
  style.setProperty("--terminal-bg", " rgb(1, 2, 3) ");
  style.setProperty("--terminal-fg", "rgb(4, 5, 6)");
  style.setProperty("--terminal-cursor", "rgb(7, 8, 9)");
  style.setProperty("--terminal-selection", "rgba(10, 11, 12, 0.5)");

  expect(readTerminalTheme()).toEqual({
    background: "rgb(1, 2, 3)",
    foreground: "rgb(4, 5, 6)",
    cursor: "rgb(7, 8, 9)",
    selectionBackground: "rgba(10, 11, 12, 0.5)",
  });
});
