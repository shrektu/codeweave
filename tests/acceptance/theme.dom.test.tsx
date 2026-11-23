import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import type { SettingsView } from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeSettings,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const BACKEND_PID = 4242;
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface FakeMediaQuery {
  matches: boolean;
  media: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

function stubSystemTheme(initialDark: boolean): (dark: boolean) => void {
  const listeners = new Set<() => void>();
  const query: FakeMediaQuery = {
    matches: initialDark,
    media: DARK_QUERY,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return (dark) => {
    query.matches = dark;
    for (const listener of listeners) {
      listener();
    }
  };
}

function connectedClient(
  appearance: SettingsView["appearance"],
): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: BACKEND_PID });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({ settings: makeSettings({ appearance }) }),
  );
  return client;
}

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("theme_follows_system_and_setting", async () => {
  const flipSystem = stubSystemTheme(true);

  renderWithServices(<App />, connectedClient("light"));
  await screen.findByText(`PID ${BACKEND_PID.toString()}`);

  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  act(() => {
    flipSystem(false);
  });
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("theme_dark_setting_ignores_system_change", async () => {
  const flipSystem = stubSystemTheme(false);

  renderWithServices(<App />, connectedClient("dark"));
  await screen.findByText(`PID ${BACKEND_PID.toString()}`);

  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  act(() => {
    flipSystem(true);
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("theme_system_setting_follows_media_query_live", async () => {
  const flipSystem = stubSystemTheme(true);

  renderWithServices(<App />, connectedClient("system"));
  await screen.findByText(`PID ${BACKEND_PID.toString()}`);

  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  act(() => {
    flipSystem(false);
  });
  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  act(() => {
    flipSystem(true);
  });
  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

function clientWithPendingSnapshot(appearance: SettingsView["appearance"]): {
  client: FakeIpcClient;
  deliverSnapshot: () => void;
} {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: BACKEND_PID });
  let deliverSnapshot = (): void => undefined;
  const snapshot = new Promise<ReturnType<typeof makeSnapshot>>((resolve) => {
    deliverSnapshot = (): void => {
      resolve(makeSnapshot({ settings: makeSettings({ appearance }) }));
    };
  });
  client.on("sessions/snapshot", () => snapshot);
  return { client, deliverSnapshot };
}

it("launch_theme_flash_uses_saved_appearance_before_snapshot", async () => {
  localStorage.setItem("codeweave.appearance", "dark");
  stubSystemTheme(false);
  const { client, deliverSnapshot } = clientWithPendingSnapshot("dark");

  renderWithServices(<App />, client);

  expect(document.documentElement.dataset.theme).toBe("dark");
  deliverSnapshot();
  await screen.findByText(`PID ${BACKEND_PID.toString()}`);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("launch_theme_flash_no_theme_source_before_snapshot", async () => {
  const setThemeSource = vi.fn(() => Promise.resolve());
  window.codeweave = makeCodeweaveApi({ setThemeSource });
  localStorage.setItem("codeweave.appearance", "dark");
  stubSystemTheme(false);
  const { client, deliverSnapshot } = clientWithPendingSnapshot("dark");

  renderWithServices(<App />, client);

  expect(setThemeSource).not.toHaveBeenCalled();
  deliverSnapshot();
  await waitFor(() => {
    expect(setThemeSource).toHaveBeenCalledTimes(1);
  });
  expect(setThemeSource).toHaveBeenCalledWith("dark");
});

it("theme_source_is_sent_to_main_when_setting_changes", async () => {
  const setThemeSource = vi.fn(() => Promise.resolve());
  window.codeweave = makeCodeweaveApi({ setThemeSource });
  stubSystemTheme(true);

  renderWithServices(<App />, connectedClient("light"));

  await waitFor(() => {
    expect(setThemeSource).toHaveBeenCalledWith("light");
  });
});
