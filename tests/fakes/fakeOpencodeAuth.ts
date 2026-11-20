import { readFile } from "node:fs/promises";

import type { ExecOptions, ExecText } from "../../src/backend/exec";

export const AUTH_LIST_ARGS: readonly string[] = [
  "auth",
  "list",
  "--format",
  "json",
  "--standalone",
];
export const USAGE_LIMITS_ARGS: readonly string[] = [
  "api",
  "experimental.usage.limits",
  "--standalone",
];
export const DB_ENV = "OPENCODE_DB";

export const NO_USAGE_OUTPUT = '{"location":{"directory":"/x"},"data":null}';

export const LOGGED_IN_OUTPUT = JSON.stringify([
  {
    id: "opencode",
    name: "OpenCode Console",
    connections: [
      { type: "credential", id: "cred_x", label: "Personal", method: "oauth" },
    ],
  },
]);

export const NEEDS_AUTH_OUTPUT = JSON.stringify([
  {
    id: "opencode",
    name: "OpenCode Console",
    connections: [
      {
        type: "credential",
        id: "cred_x",
        label: "Personal",
        method: "oauth",
        status: {
          status: "needs_auth",
          message: "Reconnect OpenCode Console to continue",
        },
      },
    ],
  },
]);

export interface AuthCliCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly envKeys: readonly string[];
  readonly db: string | undefined;
  readonly cwd: string | undefined;
  readonly timeoutMs: number | undefined;
}

export interface FakeAuthCli {
  readonly exec: ExecText;
  readonly calls: AuthCallLog;
  hangNext: number;
  failure: Error | null;
  usageOutput: string;
  usageFailure: Error | null;
}

type AuthCallLog = AuthCliCall[];

const NOT_LOGGED_IN_OUTPUT = "[]";

async function loginStateOf(db: string | undefined): Promise<string> {
  if (db === undefined) {
    return NOT_LOGGED_IN_OUTPUT;
  }
  try {
    return await readFile(db, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NOT_LOGGED_IN_OUTPUT;
    }
    throw error;
  }
}

function hangUntilTimeout(options: ExecOptions | undefined): Promise<string> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error("auth list timed out"));
    }, options?.timeoutMs ?? 0).unref();
  });
}

function callOf(
  file: string,
  args: readonly string[],
  options: ExecOptions | undefined,
): AuthCliCall {
  return {
    file,
    args: [...args],
    envKeys: Object.keys(options?.env ?? {}),
    db: options?.env?.[DB_ENV],
    cwd: options?.cwd,
    timeoutMs: options?.timeoutMs,
  };
}

export function createFakeAuthCli(): FakeAuthCli {
  const calls: AuthCallLog = [];
  const cli: FakeAuthCli = {
    calls,
    hangNext: 0,
    failure: null,
    usageOutput: NO_USAGE_OUTPUT,
    usageFailure: null,
    exec: async (file, args, options) => {
      calls.push(callOf(file, args, options));
      if (args.join(" ") === USAGE_LIMITS_ARGS.join(" ")) {
        if (cli.usageFailure !== null) {
          throw cli.usageFailure;
        }
        return cli.usageOutput;
      }
      if (cli.failure !== null) {
        throw cli.failure;
      }
      if (cli.hangNext > 0) {
        cli.hangNext -= 1;
        return hangUntilTimeout(options);
      }
      return loginStateOf(options?.env?.[DB_ENV]);
    },
  };
  return cli;
}
