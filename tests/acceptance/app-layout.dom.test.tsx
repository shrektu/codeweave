import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { EffectLevel } from "../../src/domain/types";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeSettings,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const BACKEND_PID = 4242;

function connectedClient(settings = makeSettings()): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: BACKEND_PID });
  client.respond("sessions/snapshot", makeSnapshot({ settings }));
  return client;
}

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("app_layout_shows_english_regions", async () => {
  renderWithServices(<App />, connectedClient());

  expect(screen.getByRole("region", { name: "Accounts" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Session" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Limits" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Switch log" })).toBeTruthy();
  expect(await screen.findByText(`PID ${BACKEND_PID.toString()}`)).toBeTruthy();
});

it("backend_pill_hides_pid_in_production", async () => {
  vi.stubEnv("DEV", false);
  renderWithServices(<App />, connectedClient());

  const pill = await screen.findByText("Connected");
  expect(pill.getAttribute("data-pid")).toBe(BACKEND_PID.toString());
  expect(screen.queryByText(/PID/)).toBeNull();
});

it("backend_pill_shows_pid_in_dev", async () => {
  vi.stubEnv("DEV", true);
  renderWithServices(<App />, connectedClient());

  const pill = await screen.findByText(`PID ${BACKEND_PID.toString()}`);
  expect(pill.getAttribute("data-pid")).toBe(BACKEND_PID.toString());
  expect(screen.queryByText("Connected")).toBeNull();
});

it("app_header_shows_disconnected_when_ping_fails", async () => {
  const client = createFakeIpcClient();
  client.fail("ping", new Error("port closed"));
  client.fail("sessions/snapshot", new Error("port closed"));

  renderWithServices(<App />, client);

  expect(await screen.findByText("Disconnected")).toBeTruthy();
});

it("app_effect_level_follows_settings", async () => {
  const client = connectedClient(
    makeSettings({ effectLevel: EffectLevel.low }),
  );

  renderWithServices(<App />, client);

  await screen.findByText(`PID ${BACKEND_PID.toString()}`);
  await waitFor(() => {
    expect(document.documentElement.dataset.fx).toBe("low");
  });
});
