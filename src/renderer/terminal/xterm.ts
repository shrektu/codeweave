import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { createContext } from "react";

import type { EffectLevel } from "../effects";

import {
  levelOptions,
  readTerminalTheme,
  terminalOptions,
  type TerminalRenderer,
} from "./options";
import { createRendererSwitch } from "./rendererSwitch";
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
  setGpuAccelerated(accelerated: boolean): void;
  focus(): void;
  dispose(): void;
}

export type TerminalFactory = (
  host: HTMLElement,
  options: TerminalCreateOptions,
) => TerminalHandle;

function attachWebgl(
  terminal: Terminal,
  onLoss: () => void,
): (() => void) | null {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      onLoss();
    });
    terminal.loadAddon(addon);
    return () => {
      addon.dispose();
    };
  } catch (error: unknown) {
    console.warn("WebGL renderer unavailable, using the DOM renderer", error);
    return null;
  }
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
  const renderer = createRendererSwitch(
    (onLoss) => attachWebgl(terminal, onLoss),
    gpuAccelerated,
  );

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
    setGpuAccelerated(accelerated): void {
      renderer.setGpuAccelerated(accelerated);
    },
    focus(): void {
      terminal.focus();
    },
    dispose(): void {
      renderer.dispose();
      terminal.dispose();
    },
  };
}

export const TerminalFactoryContext =
  createContext<TerminalFactory>(createXtermTerminal);
