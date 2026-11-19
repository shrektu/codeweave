import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  IpcError,
  IpcErrorCode,
  type ParamsMap,
  type ResultMap,
} from "../../shared/protocol";
import type { TerminalView } from "../../shared/views";
import type { ConnectionRegistry } from "../connections";
import {
  TERMINAL_COLOR_TERM,
  TERMINAL_KILL_SIGNAL,
  TERMINAL_PROGRAM,
  TERMINAL_TYPE,
} from "../constants";
import { inheritedEnv } from "../env";
import type { LockKeyResolver } from "../locks";
import type {
  ContainerOps,
  Launched,
  Launcher,
  ProcessContainer,
  SpawnSpec,
} from "../process/container";
import { createSerializer, type Serializer } from "../serialize";

import type { PtyLauncherFactory, PtyProcess } from "./pty";
import { TerminalSession, type ScheduleTimer } from "./session";
import type { ShellCommand, ShellDetector } from "./shell";

export interface TerminalServiceDeps {
  readonly container: ProcessContainer | null;
  readonly launcher: PtyLauncherFactory;
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly readShellSetting: () => Promise<string | null>;
  readonly detectShell: ShellDetector;
  readonly platform: NodeJS.Platform;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly newRunId: () => string;
  readonly schedule: ScheduleTimer;
  readonly resolveLockKey: LockKeyResolver;
}

export interface TerminalService {
  view(): TerminalView | null;
  open(params: ParamsMap["terminal/open"]): Promise<ResultMap["terminal/open"]>;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  ack(id: string, chars: number): void;
  detach(id: string): void;
  close(id: string): Promise<ResultMap["terminal/close"]>;
  retarget(cwd: string): Promise<void>;
  detachAll(): void;
  shutdown(): Promise<void>;
}

function terminalEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...inheritedEnv(parent),
    TERM: TERMINAL_TYPE,
    COLORTERM: TERMINAL_COLOR_TERM,
    TERM_PROGRAM: TERMINAL_PROGRAM,
  };
}

function uncontainedOps(
  pty: PtyProcess,
  platform: NodeJS.Platform,
): ContainerOps {
  return {
    members: () => Promise.resolve(pty.hasExited() ? [] : [pty.pid]),
    killMembers: () => {
      if (!pty.hasExited()) {
        pty.kill(platform === "win32" ? undefined : TERMINAL_KILL_SIGNAL);
      }
      return Promise.resolve();
    },
  };
}

async function assertDirectory(cwd: string): Promise<void> {
  try {
    if ((await stat(cwd)).isDirectory()) {
      return;
    }
  } catch (error) {
    console.warn(`terminal folder is not accessible: ${cwd}`, error);
  }
  throw new IpcError(
    IpcErrorCode.NOT_FOUND,
    `The folder does not exist: ${cwd}`,
  );
}

async function isSameFolder(
  resolveKey: LockKeyResolver,
  current: string,
  target: string,
): Promise<boolean> {
  const targetKey = await resolveKey(target);
  try {
    return (await resolveKey(current)) === targetKey;
  } catch (error) {
    console.warn(`terminal folder cannot be resolved: ${current}`, error);
    return false;
  }
}

function launchFailure(error: unknown): IpcError {
  console.error("terminal shell failed to start", error);
  const reason = error instanceof Error ? error.message : String(error);
  return new IpcError(
    IpcErrorCode.UNAVAILABLE,
    `The terminal shell could not be started: ${reason}`,
  );
}

class TerminalController implements TerminalService {
  private readonly deps: TerminalServiceDeps;
  private readonly serialized: Serializer = createSerializer();
  private current: TerminalSession | null = null;

  constructor(deps: TerminalServiceDeps) {
    this.deps = deps;
  }

  view(): TerminalView | null {
    return this.current?.view() ?? null;
  }

  open(
    params: ParamsMap["terminal/open"],
  ): Promise<ResultMap["terminal/open"]> {
    return this.serialized(() => this.openSerialized(params));
  }

  input(id: string, data: string): void {
    this.runningSession(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.runningSession(id).resize(cols, rows);
  }

  ack(id: string, chars: number): void {
    this.knownSession(id).ack(chars);
  }

  detach(id: string): void {
    this.knownSession(id).detach();
  }

  close(id: string): Promise<ResultMap["terminal/close"]> {
    return this.serialized(async () => {
      const session = this.current;
      if (session?.id !== id) {
        return { closed: false };
      }
      await this.discard(session);
      return { closed: true };
    });
  }

  retarget(cwd: string): Promise<void> {
    return this.serialized(async () => {
      const session = this.current;
      if (
        session !== null &&
        !(await isSameFolder(this.deps.resolveLockKey, session.cwd, cwd))
      ) {
        await this.discard(session);
      }
    });
  }

  detachAll(): void {
    this.current?.detach();
  }

  shutdown(): Promise<void> {
    return this.serialized(async () => {
      if (this.current !== null) {
        await this.discard(this.current);
      }
    });
  }

  private knownSession(id: string): TerminalSession {
    if (this.current?.id !== id) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Unknown terminal: ${id}`);
    }
    return this.current;
  }

  private runningSession(id: string): TerminalSession {
    const session = this.knownSession(id);
    if (session.isExited()) {
      throw new IpcError(IpcErrorCode.CONFLICT, "The terminal has exited");
    }
    return session;
  }

  private async openSerialized({
    cwd,
    cols,
    rows,
  }: ParamsMap["terminal/open"]): Promise<ResultMap["terminal/open"]> {
    const existing = this.current;
    if (
      existing !== null &&
      !existing.isExited() &&
      resolve(existing.cwd) === resolve(cwd)
    ) {
      existing.resize(cols, rows);
      return { terminal: existing.view(), replay: existing.attach() };
    }
    await assertDirectory(cwd);
    const shell = await this.deps.detectShell(
      await this.deps.readShellSetting(),
    );
    this.current = null;
    await existing?.stop();
    const session = await this.launch(shell, { cwd, cols, rows }).catch(
      (error: unknown) => {
        if (existing !== null) {
          this.deps.broadcast("terminal/changed", null);
        }
        throw launchFailure(error);
      },
    );
    this.current = session;
    const replay = session.attach();
    this.deps.broadcast("terminal/changed", session.view());
    return { terminal: session.view(), replay };
  }

  private async launch(
    shell: ShellCommand,
    { cwd, cols, rows }: ParamsMap["terminal/open"],
  ): Promise<TerminalSession> {
    const id = this.deps.newRunId();
    const spec: SpawnSpec = {
      command: shell.command,
      args: shell.args,
      env: terminalEnv(this.deps.parentEnv),
      cwd,
      runId: id,
    };
    const { process: pty, ops } = await this.start(
      spec,
      this.deps.launcher({ cols, rows }),
    );
    return new TerminalSession({
      id,
      cwd,
      shell: shell.command,
      pty,
      ops,
      platform: this.deps.platform,
      schedule: this.deps.schedule,
      emitData: (terminalId, data) => {
        this.deps.broadcast("terminal/data", { id: terminalId, data });
      },
      emitChanged: (view) => {
        this.deps.broadcast("terminal/changed", view);
      },
    });
  }

  private async start(
    spec: SpawnSpec,
    launcher: Launcher<PtyProcess>,
  ): Promise<Launched<PtyProcess>> {
    if (this.deps.container !== null) {
      return this.deps.container.launch(spec, launcher);
    }
    const pty = await launcher(spec.command, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
    });
    return { process: pty, ops: uncontainedOps(pty, this.deps.platform) };
  }

  private async discard(session: TerminalSession): Promise<void> {
    this.current = null;
    this.deps.broadcast("terminal/changed", null);
    await session.stop();
  }
}

export function createTerminalService(
  deps: TerminalServiceDeps,
): TerminalService {
  return new TerminalController(deps);
}
