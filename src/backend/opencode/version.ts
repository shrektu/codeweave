import { stripVTControlCharacters } from "node:util";

import type { ExecText } from "../exec";

import {
  OpencodeGeneration,
  SUPPORTED_MAJOR_VERSION,
  VERSION_ARG,
  VERSION_PATTERN,
  VERSION_PROBE_TIMEOUT_MS,
  VERSION_SUPPORT_HINT,
  VERSION_UNKNOWN_MESSAGE,
} from "./constants";
import { buildOpencodeCommand } from "./launch";

export interface OpencodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface GenerationProbeOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export type GenerationProbe = (
  executable: string,
  options: GenerationProbeOptions,
) => Promise<OpencodeGeneration>;

export interface VersionProbeDeps {
  readonly exec: ExecText;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string | undefined;
}

export class UnsupportedOpencodeVersionError extends Error {
  override name = "UnsupportedOpencodeVersionError";

  private constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }

  static unsupported(
    version: OpencodeVersion,
  ): UnsupportedOpencodeVersionError {
    return new UnsupportedOpencodeVersionError(
      `OpenCode ${formatOpencodeVersion(version)} is not supported. ${VERSION_SUPPORT_HINT}`,
    );
  }

  static undetectable(cause?: unknown): UnsupportedOpencodeVersionError {
    return new UnsupportedOpencodeVersionError(
      `${VERSION_UNKNOWN_MESSAGE} ${VERSION_SUPPORT_HINT}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export function parseOpencodeVersion(stdout: string): OpencodeVersion | null {
  const line = stripVTControlCharacters(stdout)
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  const match = line === undefined ? null : VERSION_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

export function formatOpencodeVersion(version: OpencodeVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

export function generationOf(
  version: OpencodeVersion,
): OpencodeGeneration | null {
  return version.major === SUPPORTED_MAJOR_VERSION
    ? OpencodeGeneration.v1
    : null;
}

export function createVersionProbe(deps: VersionProbeDeps): GenerationProbe {
  return async (executable, { env, cwd }) => {
    const command = buildOpencodeCommand({
      executable,
      args: [VERSION_ARG],
      platform: deps.platform,
      comSpec: deps.comSpec,
    });
    let stdout: string;
    try {
      stdout = await deps.exec(command.command, command.args, {
        timeoutMs: VERSION_PROBE_TIMEOUT_MS,
        env,
        cwd,
        ...(command.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
      });
    } catch (error) {
      console.error("the opencode version command failed", error);
      throw UnsupportedOpencodeVersionError.undetectable(error);
    }
    const version = parseOpencodeVersion(stdout);
    if (version === null) {
      const error = UnsupportedOpencodeVersionError.undetectable();
      console.error("the opencode version output is unreadable", error);
      throw error;
    }
    const generation = generationOf(version);
    if (generation === null) {
      throw UnsupportedOpencodeVersionError.unsupported(version);
    }
    return generation;
  };
}
