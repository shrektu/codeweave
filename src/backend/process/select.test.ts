import { describe, expect, it } from "vitest";

import { createHangingExec } from "../../../tests/fakes/hangingExec";
import { SYSTEMD_CALL_TIMEOUT_MS } from "../constants";

import { ContainerKind, ContainerUnavailableError } from "./container";
import { createProcessContainer, probeSystemdUser } from "./select";

describe("createProcessContainer", () => {
  it("create_container_refuses_unsupported_platform", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      await expect(
        createProcessContainer(platform, () => Promise.resolve(true)),
      ).rejects.toBeInstanceOf(ContainerUnavailableError);
    }
  });

  it("probe_timeout_falls_back_to_marker_container", async () => {
    const { exec, calls } = createHangingExec(["--scope"]);

    const container = await createProcessContainer("linux", () =>
      probeSystemdUser(exec),
    );

    expect(container.kind).toBe(ContainerKind.envMarker);
    expect(calls.map((call) => call.timeoutMs)).toEqual([
      SYSTEMD_CALL_TIMEOUT_MS,
    ]);
  });

  it("linux_with_systemd_user_uses_scope_container", async () => {
    const container = await createProcessContainer("linux", () =>
      Promise.resolve(true),
    );

    expect(container.kind).toBe(ContainerKind.systemdScope);
  });
});
