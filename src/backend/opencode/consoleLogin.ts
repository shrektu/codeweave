import { stripVTControlCharacters } from "node:util";

import { z } from "zod";

import type { ExecText } from "../exec";

import { OpencodeEnv } from "./constants";
import {
  accountDirs,
  buildOpencodeCommand,
  consoleLoginDbPath,
  isolationEnv,
} from "./launch";

export const ConsoleLoginState = {
  loggedIn: "logged_in",
  needsLogin: "needs_login",
  failed: "failed",
} as const;
export type ConsoleLoginState =
  (typeof ConsoleLoginState)[keyof typeof ConsoleLoginState];

export const CONSOLE_LOGIN_PROBE_TIMEOUT_MS = 15_000;

const AUTH_LIST_ARGS: readonly string[] = [
  "auth",
  "list",
  "--format",
  "json",
  "--standalone",
];
const CONSOLE_PROVIDER_ID = "opencode";
const CREDENTIAL_CONNECTION = "credential";
const NEEDS_AUTH_STATUS = "needs_auth";
const JSON_LIST_OPEN = "[";
const JSON_LIST_CLOSE = "]";
const LINE_BREAK = "\n";
const ABORTED_MESSAGE = "console login probe aborted";
const REASON_TIMEOUT = "timeout";
const REASON_ERROR = "error";

const AuthListSchema = z.array(
  z.object({
    id: z.string(),
    connections: z.array(
      z.object({
        type: z.string(),
        status: z.object({ status: z.string() }).optional(),
      }),
    ),
  }),
);
type AuthList = z.infer<typeof AuthListSchema>;

export interface ConsoleLoginDeps {
  readonly exec: ExecText;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string | undefined;
  readonly timeoutMs?: number;
}

export interface ConsoleLoginInput {
  readonly executable: string;
  readonly configDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type ConsoleLoginProbe = (
  input: ConsoleLoginInput,
) => Promise<ConsoleLoginState>;

function listFrom(candidate: string): AuthList | null {
  const end = candidate.lastIndexOf(JSON_LIST_CLOSE);
  if (end < 0) {
    return null;
  }
  try {
    const parsed = AuthListSchema.safeParse(
      JSON.parse(candidate.slice(0, end + 1)),
    );
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.warn(
      "an opencode console login output candidate is not JSON",
      error instanceof Error ? error.name : REASON_ERROR,
    );
    return null;
  }
}

function parseAuthList(stdout: string): AuthList | null {
  const lines = stripVTControlCharacters(stdout).split(LINE_BREAK);
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith(JSON_LIST_OPEN)) {
      const list = listFrom(lines.slice(index).join(LINE_BREAK).trimStart());
      if (list !== null) {
        return list;
      }
    }
  }
  return null;
}

function hasLiveCredential(list: AuthList): boolean {
  return list.some(
    (entry) =>
      entry.id === CONSOLE_PROVIDER_ID &&
      entry.connections.some(
        (connection) =>
          connection.type === CREDENTIAL_CONNECTION &&
          connection.status?.status !== NEEDS_AUTH_STATUS,
      ),
  );
}

function failureReason(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return REASON_ERROR;
  }
  if ("killed" in error && error.killed === true) {
    return REASON_TIMEOUT;
  }
  return "code" in error && typeof error.code === "number"
    ? `exit ${String(error.code)}`
    : REASON_ERROR;
}

function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(new Error(ABORTED_MESSAGE));
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => {
    aborted.reject(new Error(ABORTED_MESSAGE));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

function probeEnv(input: ConsoleLoginInput): Record<string, string> {
  return {
    ...input.env,
    ...accountDirs(input.configDir),
    [OpencodeEnv.db]: consoleLoginDbPath(input.configDir),
    ...isolationEnv(),
  };
}

export async function probeConsoleLogin(
  deps: ConsoleLoginDeps,
  input: ConsoleLoginInput,
): Promise<ConsoleLoginState> {
  const command = buildOpencodeCommand({
    executable: input.executable,
    args: AUTH_LIST_ARGS,
    platform: deps.platform,
    comSpec: deps.comSpec,
  });
  let stdout: string;
  try {
    stdout = await untilAborted(
      deps.exec(command.command, command.args, {
        timeoutMs: deps.timeoutMs ?? CONSOLE_LOGIN_PROBE_TIMEOUT_MS,
        env: probeEnv(input),
        cwd: input.configDir,
        ...(command.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
      }),
      input.signal,
    );
  } catch (error) {
    console.warn(
      `the opencode console login probe failed: ${failureReason(error)}`,
    );
    return ConsoleLoginState.failed;
  }
  const list = parseAuthList(stdout);
  if (list === null) {
    console.warn("the opencode console login output is unreadable");
    return ConsoleLoginState.failed;
  }
  return hasLiveCredential(list)
    ? ConsoleLoginState.loggedIn
    : ConsoleLoginState.needsLogin;
}

export function createConsoleLoginProbe(
  deps: ConsoleLoginDeps,
): ConsoleLoginProbe {
  return (input) => probeConsoleLogin(deps, input);
}
