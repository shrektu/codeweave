import type { EffectLevel } from "../effects";
import { errorMessage } from "../errorMessage";
import type { IpcClient } from "../ipc";

import {
  beginAttachment,
  isCloseRequested,
  isLatestAttachment,
} from "./attachments";
import { splitInput } from "./input";
import type { TerminalRenderer } from "./options";
import {
  boundTerminalSize,
  DEFAULT_TERMINAL_SIZE,
  isSameSize,
  type TerminalSize,
} from "./size";
import type { TerminalHandle } from "./xterm";

export type TerminalState =
  | { kind: "starting" }
  | { kind: "ready"; renderer: TerminalRenderer }
  | { kind: "failed"; message: string };

export interface TerminalConnection {
  setLevel(level: EffectLevel): void;
  stop(): void;
}

export interface ConnectionDeps {
  client: IpcClient;
  host: HTMLElement;
  cwd: string;
  createHandle: (host: HTMLElement) => TerminalHandle;
  report: (state: TerminalState) => void;
}

interface FrameTask {
  schedule(): void;
  cancel(): void;
}

interface TerminalChunk {
  id: string;
  data: string;
}

function createFrameTask(run: () => void): FrameTask {
  let frame: number | null = null;
  return {
    schedule(): void {
      frame ??= requestAnimationFrame(() => {
        frame = null;
        run();
      });
    },
    cancel(): void {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    },
  };
}

function createMicrotaskTask(run: () => void): FrameTask {
  let queued = false;
  let cancelled = false;
  return {
    schedule(): void {
      if (queued) {
        return;
      }
      queued = true;
      cancelled = false;
      queueMicrotask(() => {
        queued = false;
        if (!cancelled) {
          run();
        }
      });
    },
    cancel(): void {
      cancelled = true;
    },
  };
}

function warnOnFailure(action: string): (error: unknown) => void {
  return (error) => {
    console.warn(`Terminal ${action} failed`, error);
  };
}

class TerminalLink implements TerminalConnection {
  private readonly deps: ConnectionDeps;
  private readonly handle: TerminalHandle;
  private readonly generation: number;
  private readonly ackTask: FrameTask;
  private readonly resizeTask: FrameTask;
  private readonly observer: ResizeObserver;
  private readonly unsubscribe: (() => void)[];
  private active = true;
  private terminalId: string | null = null;
  private lastSize: TerminalSize | null = null;
  private unackedChars = 0;

  constructor(deps: ConnectionDeps, handle: TerminalHandle) {
    this.deps = deps;
    this.handle = handle;
    this.generation = beginAttachment(deps.client);
    this.ackTask = createMicrotaskTask(() => {
      this.flushAck();
    });
    this.resizeTask = createFrameTask(() => {
      this.syncSize();
    });
    this.observer = new ResizeObserver(() => {
      this.resizeTask.schedule();
    });
    this.observer.observe(deps.host);
    this.unsubscribe = [
      deps.client.subscribe((event) => {
        if (event.event === "terminal/data") {
          this.onChunk(event.payload);
        }
      }),
      handle.onData((data) => {
        this.sendInput(data);
      }),
      handle.onRendererChange((renderer) => {
        if (this.active && this.terminalId !== null) {
          deps.report({ kind: "ready", renderer });
        }
      }),
    ];
    void this.open();
  }

  setLevel(level: EffectLevel): void {
    this.handle.setLevel(level);
  }

  stop(): void {
    this.active = false;
    this.ackTask.cancel();
    this.resizeTask.cancel();
    this.observer.disconnect();
    for (const dispose of this.unsubscribe) {
      dispose();
    }
    this.handle.dispose();
    if (this.terminalId !== null) {
      this.release(this.terminalId);
    }
  }

  private release(id: string): void {
    const { client } = this.deps;
    if (
      isLatestAttachment(client, this.generation) &&
      isCloseRequested(client)
    ) {
      void client
        .request("terminal/close", { id })
        .catch(warnOnFailure("close"));
      return;
    }
    void client
      .request("terminal/detach", { id })
      .catch(warnOnFailure("detach"));
  }

  private fail(error: unknown): void {
    if (this.active) {
      this.deps.report({ kind: "failed", message: errorMessage(error) });
    }
  }

  private async open(): Promise<void> {
    try {
      const size = boundTerminalSize(
        this.handle.fit() ?? DEFAULT_TERMINAL_SIZE,
      );
      const opened = await this.deps.client.request("terminal/open", {
        cwd: this.deps.cwd,
        ...size,
      });
      if (!this.active) {
        if (isLatestAttachment(this.deps.client, this.generation)) {
          this.release(opened.terminal.id);
        }
        return;
      }
      this.terminalId = opened.terminal.id;
      this.lastSize = size;
      if (opened.replay !== "") {
        this.handle.write(opened.replay);
      }
      this.deps.report({ kind: "ready", renderer: this.handle.renderer });
      this.handle.focus();
      this.resizeTask.schedule();
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  private onChunk(chunk: TerminalChunk): void {
    if (chunk.id === this.terminalId) {
      this.handle.write(chunk.data, () => {
        if (this.active) {
          this.unackedChars += chunk.data.length;
          this.ackTask.schedule();
        }
      });
    }
  }

  private flushAck(): void {
    const chars = this.unackedChars;
    this.unackedChars = 0;
    if (this.terminalId !== null && chars > 0) {
      void this.deps.client
        .request("terminal/ack", { id: this.terminalId, chars })
        .catch(warnOnFailure("acknowledgement"));
    }
  }

  private sendInput(data: string): void {
    const id = this.terminalId;
    if (id === null) {
      return;
    }
    for (const chunk of splitInput(data)) {
      void this.deps.client
        .request("terminal/input", { id, data: chunk })
        .catch((error: unknown) => {
          this.fail(error);
        });
    }
  }

  private syncSize(): void {
    const fitted = this.handle.fit();
    if (fitted === null || this.terminalId === null) {
      return;
    }
    const size = boundTerminalSize(fitted);
    if (isSameSize(this.lastSize, size)) {
      return;
    }
    this.lastSize = size;
    void this.deps.client
      .request("terminal/resize", { id: this.terminalId, ...size })
      .catch((error: unknown) => {
        this.fail(error);
      });
  }
}

const NOOP_CONNECTION: TerminalConnection = {
  setLevel: () => undefined,
  stop: () => undefined,
};

export function connectTerminal(deps: ConnectionDeps): TerminalConnection {
  try {
    return new TerminalLink(deps, deps.createHandle(deps.host));
  } catch (error: unknown) {
    console.error("Terminal could not be created", error);
    deps.report({ kind: "failed", message: errorMessage(error) });
    return NOOP_CONNECTION;
  }
}
