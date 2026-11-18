import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { App } from "../../src/renderer/App";
import {
  createFakeGpuAcceleration,
  makeCodeweaveApi,
} from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeSnapshot,
  renderWithServices,
} from "../fakes/fakeIpcClient";

const BACKEND_PID = 4242;

afterEach(() => {
  cleanup();
});

it("effects_become_full_when_gpu_acceleration_is_reported_after_start", async () => {
  const gpu = createFakeGpuAcceleration(false);
  window.codeweave = makeCodeweaveApi(gpu.api);
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: BACKEND_PID });
  client.respond("sessions/snapshot", makeSnapshot());

  renderWithServices(<App />, client);

  await screen.findByText(`PID ${BACKEND_PID.toString()}`);
  expect(document.documentElement.dataset.fx).toBe("low");

  act(() => {
    gpu.set(true);
  });

  await waitFor(() => {
    expect(document.documentElement.dataset.fx).toBe("full");
  });
});
