import { TerminalStatus } from "../../domain/types";
import type { TerminalView } from "../../shared/views";
import {
  TERMINAL_FLUSH_MAX_CHARS,
  TERMINAL_FLUSH_MS,
  TERMINAL_STOP_GRACE_MS,
  TERMINAL_STOP_SIGNAL,
} from "../constants";
import { confirmEmpty, killQuietly } from "../process/contained";
import type { ContainerOps } from "../process/container";

import { FlowAction, FlowGate, ReplayRing } from "./output";
import type { PtyExit, PtyProcess } from "./pty";

export type CancelTimer = () => void;
export type ScheduleTimer = (run: () => void, delayMs: number) => CancelTimer;

export interface TerminalSessionDeps {
  readonly id: string;
  readonly cwd: string;
  readonly shell: string;
  readonly pty: PtyProcess;
  readonly ops: ContainerOps;
  readonly platform: NodeJS.Platform;
  readonly schedule: ScheduleTimer;
  readonly emitData: (id: string, data: string) => void;
  readonly emitChanged: (view: TerminalView) => void;
}

export class TerminalSession {
  readonly id: string;
  readonly cwd: string;
  private readonly deps: TerminalSessionDeps;
  private readonly ring = new ReplayRing();
  private readonly gate = new FlowGate();
  private readonly exited = Promise.withResolvers<undefined>();
  private status: TerminalStatus = TerminalStatus.running;
  private exitCode: number | null = null;
  private attached = false;
  private retired = false;
  private pending = "";
  private cancelFlush: CancelTimer | null = null;
  private cleanup: Promise<void> | null = null;

  constructor(deps: TerminalSessionDeps) {
    this.deps = deps;
    this.id = deps.id;
    this.cwd = deps.cwd;
    deps.pty.onData((data) => {
      this.handleData(data);
    });
    deps.pty.onExit((exit) => {
      this.handleExit(exit);
    });
  }

  view(): TerminalView {
    return {
      id: this.id,
      cwd: this.cwd,
      shell: this.deps.shell,
      status: this.status,
      exitCode: this.exitCode,
    };
  }

  isExited(): boolean {
    return this.status === TerminalStatus.exited;
  }

  attach(): string {
    this.attached = true;
    this.discardPending();
    this.applyFlow(this.gate.reset());
    return this.ring.snapshot();
  }

  detach(): void {
    this.attached = false;
    this.discardPending();
    this.applyFlow(this.gate.reset());
  }

  write(data: string): void {
    this.deps.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.deps.pty.resize(cols, rows);
  }

  ack(chars: number): void {
    this.applyFlow(this.gate.onAck(chars));
  }

  async stop(): Promise<void> {
    this.retired = true;
    this.discardPending();
    if (!this.deps.pty.hasExited()) {
      this.requestExit();
      await this.waitForExit();
    }
    await this.reap();
  }

  private handleData(data: string): void {
    this.ring.append(data);
    if (!this.attached || this.retired) {
      return;
    }
    this.pending += data;
    this.applyFlow(this.gate.onSent(data.length));
    if (this.pending.length >= TERMINAL_FLUSH_MAX_CHARS) {
      this.flush();
    } else {
      this.cancelFlush ??= this.deps.schedule(() => {
        this.flush();
      }, TERMINAL_FLUSH_MS);
    }
  }

  private handleExit({ exitCode }: PtyExit): void {
    this.status = TerminalStatus.exited;
    this.exitCode = exitCode;
    if (this.retired) {
      this.discardPending();
    } else {
      this.flush();
      this.deps.emitChanged(this.view());
    }
    this.exited.resolve(undefined);
    this.reap().catch((error: unknown) => {
      console.error(`terminal ${this.id} cleanup failed`, error);
    });
  }

  private applyFlow(action: FlowAction): void {
    if (action === FlowAction.pause) {
      this.deps.pty.pause();
    } else if (action === FlowAction.resume) {
      this.deps.pty.resume();
    }
  }

  private flush(): void {
    const data = this.pending;
    this.discardPending();
    if (data !== "") {
      this.deps.emitData(this.id, data);
    }
  }

  private discardPending(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.pending = "";
  }

  private requestExit(): void {
    try {
      if (this.deps.platform === "win32") {
        this.deps.pty.kill();
      } else {
        this.deps.pty.kill(TERMINAL_STOP_SIGNAL);
      }
    } catch (error) {
      console.error(`terminal ${this.id} could not be signalled`, error);
    }
  }

  private async waitForExit(): Promise<void> {
    let cancelGrace: CancelTimer = () => undefined;
    const graceElapsed = new Promise<void>((resolve) => {
      cancelGrace = this.deps.schedule(resolve, TERMINAL_STOP_GRACE_MS);
    });
    await Promise.race([this.exited.promise, graceElapsed]);
    cancelGrace();
  }

  private reap(): Promise<void> {
    this.cleanup ??= Promise.resolve().then(() => this.killMembersAndConfirm());
    return this.cleanup;
  }

  private async killMembersAndConfirm(): Promise<void> {
    await killQuietly(this.deps.ops);
    const result = await confirmEmpty(this.deps.ops);
    if (!result.ok) {
      console.error(
        `terminal ${this.id} left processes behind: ${result.survivors.join(",")}`,
      );
    }
  }
}
