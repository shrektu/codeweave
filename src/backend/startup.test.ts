import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderId } from "../domain/types";
import { IpcErrorCode } from "../shared/protocol";
import {
  hostBinDirWith as binDirWith,
  hostExecutable,
  hostResolverEnv,
} from "../../tests/fakes/processHelpers";

import { createExecutableResolver } from "./startup";

describe("createExecutableResolver", () => {
  it("resolves_each_provider_binary_from_path", async () => {
    const dir = await binDirWith("claude", "codex");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(resolve(ProviderId.claude, null)).toBe(
      hostExecutable(dir, "claude"),
    );
    expect(resolve(ProviderId.codex, null)).toBe(hostExecutable(dir, "codex"));
  });

  it("configured_path_wins_over_path_lookup", async () => {
    const dir = await binDirWith("codex");
    const custom = await binDirWith("my-codex");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(resolve(ProviderId.codex, hostExecutable(custom, "my-codex"))).toBe(
      hostExecutable(custom, "my-codex"),
    );
  });

  it.each([
    [ProviderId.claude, "The Claude executable was not found"],
    [ProviderId.codex, "The Codex executable was not found"],
  ])("missing_%s_binary_is_unavailable", async (provider, message) => {
    const dir = await binDirWith("unrelated");
    const resolve = createExecutableResolver({ PATH: dir }, "linux");

    expect(() => resolve(provider, null)).toThrow(
      expect.objectContaining({ code: IpcErrorCode.UNAVAILABLE, message }),
    );
  });

  it("missing_configured_path_is_unavailable_for_that_provider", async () => {
    const dir = await binDirWith("codex");
    const resolve = createExecutableResolver({ PATH: dir }, "linux");

    expect(() => resolve(ProviderId.codex, join(dir, "gone"))).toThrow(
      expect.objectContaining({
        code: IpcErrorCode.UNAVAILABLE,
        message: "The Codex executable was not found",
      }),
    );
  });

  it("unsupported_provider_is_unavailable", async () => {
    const dir = await binDirWith("gemini");
    const resolve = createExecutableResolver({ PATH: dir }, "linux");

    expect(() => resolve(ProviderId.gemini, null)).toThrow(
      expect.objectContaining({
        code: IpcErrorCode.UNAVAILABLE,
        message: "Provider gemini is not supported",
      }),
    );
  });
});
