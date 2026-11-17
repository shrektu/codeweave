import { describe, expect, it, vi } from "vitest";

import { createHangingExec } from "../../../tests/fakes/hangingExec";
import { SYSTEMD_CALL_TIMEOUT_MS } from "../constants";

import { ContainerKind, ContainerUnavailableError } from "./container";
import { createProcessContainer, probeSystemdUser } from "./select";

describe("createProcessContainer", () => {
  it("win32_still_reports_container_unavailable", async () => {
    await expect(
      createProcessContainer("win32", () => Promise.resolve(true)),
    ).rejects.toBeInstanceOf(ContainerUnavailableError);
  });

  it("darwin_selects_marker_container_without_probing", async () => {
    const probe = vi.fn(() => Promise.resolve(true));

    const container = await createProcessContainer("darwin", probe);

    expect(container.kind).toBe(ContainerKind.envMarker);
    expect(probe).not.toHaveBeenCalled();
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
