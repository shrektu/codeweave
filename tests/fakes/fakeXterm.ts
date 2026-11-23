import type { EffectLevel } from "../../src/renderer/effects";
import {
  chooseTerminalRenderer,
  type TerminalRenderer,
} from "../../src/renderer/terminal/options";
import type { TerminalSize } from "../../src/renderer/terminal/size";
import type {
  TerminalFactory,
  TerminalHandle,
} from "../../src/renderer/terminal/xterm";

export const FAKE_FIT_SIZE: TerminalSize = { cols: 100, rows: 30 };

export interface FakeXterm extends TerminalHandle {
  readonly host: HTMLElement;
  readonly writes: string[];
  readonly levels: EffectLevel[];
  themeRefreshes: number;
  renderer: TerminalRenderer;
  fitSize: TerminalSize | null;
  disposed: boolean;
  focused: boolean;
  type(data: string): void;
  loseContext(): void;
}

export interface FakeXtermFactory {
  readonly factory: TerminalFactory;
  readonly terminals: FakeXterm[];
}

export function createFakeXtermFactory(): FakeXtermFactory {
  const terminals: FakeXterm[] = [];
  const factory: TerminalFactory = (host, { level, gpuAccelerated }) => {
    const dataListeners = new Set<(data: string) => void>();
    const rendererListeners = new Set<(renderer: TerminalRenderer) => void>();
    const terminal: FakeXterm = {
      host,
      writes: [],
      levels: [level],
      themeRefreshes: 0,
      fitSize: FAKE_FIT_SIZE,
      disposed: false,
      focused: false,
      renderer: chooseTerminalRenderer({ gpuAccelerated, webglFailed: false }),
      write(data, done): void {
        this.writes.push(data);
        if (done !== undefined) {
          queueMicrotask(done);
        }
      },
      onData(listener): () => void {
        dataListeners.add(listener);
        return (): void => {
          dataListeners.delete(listener);
        };
      },
      onRendererChange(listener): () => void {
        rendererListeners.add(listener);
        return (): void => {
          rendererListeners.delete(listener);
        };
      },
      fit(): TerminalSize | null {
        return this.fitSize;
      },
      setLevel(next): void {
        this.levels.push(next);
      },
      refreshTheme(): void {
        this.themeRefreshes += 1;
      },
      setGpuAccelerated(accelerated): void {
        const next = chooseTerminalRenderer({
          gpuAccelerated: accelerated,
          webglFailed: false,
        });
        if (next !== this.renderer) {
          this.renderer = next;
          for (const listener of rendererListeners) {
            listener(next);
          }
        }
      },
      focus(): void {
        this.focused = true;
      },
      dispose(): void {
        this.disposed = true;
      },
      type(data): void {
        for (const listener of dataListeners) {
          listener(data);
        }
      },
      loseContext(): void {
        this.renderer = "dom";
        for (const listener of rendererListeners) {
          listener("dom");
        }
      },
    };
    terminals.push(terminal);
    return terminal;
  };
  return { factory, terminals };
}
