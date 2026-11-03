import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { createContext } from "react";

import type { EffectLevel } from "../effects";

import {
  chooseTerminalRenderer,
  levelOptions,
  readTerminalTheme,
  terminalOptions,
  type TerminalRenderer,
} from "./options";
import type { TerminalSize } from "./size";

export interface TerminalCreateOptions {
  level: EffectLevel;
  gpuAccelerated: boolean;
}

export interface TerminalHandle {
  readonly renderer: TerminalRenderer;
  write(data: string, done?: () => void): void;
  onData(listener: (data: string) => void): () => void;
  onRendererChange(listener: (renderer: TerminalRenderer) => void): () => void;
  fit(): TerminalSize | null;
  setLevel(level: EffectLevel): void;
  focus(): void;
  dispose(): void;
}

export type TerminalFactory = (
  host: HTMLElement,
  options: TerminalCreateOptions,
) => TerminalHandle;

function attachWebgl(terminal: Terminal, onLoss: () => void): boolean {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      onLoss();
    });
    terminal.loadAddon(addon);
    return true;
  } catch (error: unknown) {
    console.warn("WebGL renderer unavailable, using the DOM renderer", error);
    return false;
  }
}

interface RendererState {
  current(): TerminalRenderer;
  subscribe(listener: (renderer: TerminalRenderer) => void): () => void;
  clear(): void;
}

function trackRenderer(
  terminal: Terminal,
  gpuAccelerated: boolean,
): RendererState {
  const listeners = new Set<(renderer: TerminalRenderer) => void>();
  let renderer: TerminalRenderer = "dom";
  const fallBackToDom = (): void => {
    renderer = "dom";
    for (const listener of listeners) {
      listener(renderer);
    }
  };
  const wantsWebgl =
    chooseTerminalRenderer({ gpuAccelerated, webglFailed: false }) === "webgl";
  if (wantsWebgl && attachWebgl(terminal, fallBackToDom)) {
    renderer = "webgl";
  }
  return {
    current: () => renderer,
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      listeners.clear();
    },
  };
}

function fitTerminal(
  terminal: Terminal,
  fitAddon: FitAddon,
): TerminalSize | null {
  if (fitAddon.proposeDimensions() === undefined) {
    return null;
  }
  fitAddon.fit();
  return { cols: terminal.cols, rows: terminal.rows };
}

export function createXtermTerminal(
  host: HTMLElement,
  { level, gpuAccelerated }: TerminalCreateOptions,
): TerminalHandle {
  const terminal = new Terminal(terminalOptions(level, readTerminalTheme()));
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host);
  const renderer = trackRenderer(terminal, gpuAccelerated);

  return {
    get renderer(): TerminalRenderer {
      return renderer.current();
    },
    write(data, done): void {
      terminal.write(data, done);
    },
    onData(listener): () => void {
      const subscription = terminal.onData(listener);
      return (): void => {
        subscription.dispose();
      };
    },
    onRendererChange: (listener) => renderer.subscribe(listener),
    fit: () => fitTerminal(terminal, fitAddon),
    setLevel(next): void {
      Object.assign(terminal.options, levelOptions(next));
    },
    focus(): void {
      terminal.focus();
    },
    dispose(): void {
      renderer.clear();
      terminal.dispose();
    },
  };
}

export const TerminalFactoryContext =
  createContext<TerminalFactory>(createXtermTerminal);
