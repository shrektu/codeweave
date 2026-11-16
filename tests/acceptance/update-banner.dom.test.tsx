import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SettingsDialog } from "../../src/renderer/components/SettingsDialog";
import { UpdateBanner } from "../../src/renderer/components/UpdateBanner";
import type { AvailableUpdate } from "../../src/shared/api";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeSettings,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const BANNER_TEXT = "Codeweave 99.0.0 is available.";

interface UpdateRig {
  readonly openUpdateRelease: ReturnType<typeof vi.fn<() => Promise<void>>>;
  push(update: AvailableUpdate | null): void;
}

function installApi(initial: AvailableUpdate | null): UpdateRig {
  const openUpdateRelease = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const listeners = new Set<(update: AvailableUpdate | null) => void>();
  window.codeweave = makeCodeweaveApi({
    getAvailableUpdate: () => Promise.resolve(initial),
    onUpdateAvailable: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openUpdateRelease,
  });
  return {
    openUpdateRelease,
    push: (update) => {
      act(() => {
        for (const listener of listeners) {
          listener(update);
        }
      });
    },
  };
}

function settingsClient(
  overrides: Parameters<typeof makeSettings>[0] = {},
): FakeIpcClient {
  const client = createFakeIpcClient();
  const settings = makeSettings(overrides);
  client.respond("sessions/snapshot", makeSnapshot({ settings }));
  client.on("settings/set", () => settings);
  return client;
}

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

it("banner_shows_available_version_and_opens_release", async () => {
  const rig = installApi({ version: "99.0.0" });
  render(<UpdateBanner />);

  const banner = await screen.findByRole("status");
  expect(banner.textContent).toContain(BANNER_TEXT);

  fireEvent.click(screen.getByRole("button", { name: "View release" }));

  expect(rig.openUpdateRelease).toHaveBeenCalledTimes(1);
  expect(rig.openUpdateRelease).toHaveBeenCalledWith();
});

it("banner_is_absent_without_an_update", async () => {
  installApi(null);
  render(<UpdateBanner />);

  await waitFor(() => {
    expect(screen.queryByRole("status")).toBeNull();
  });
});

it("banner_appears_when_main_pushes_an_update", async () => {
  const rig = installApi(null);
  render(<UpdateBanner />);

  rig.push({ version: "99.0.0" });

  expect((await screen.findByRole("status")).textContent).toContain(
    BANNER_TEXT,
  );
});

it("banner_hides_when_main_clears_the_update", async () => {
  const rig = installApi({ version: "99.0.0-beta.1" });
  render(<UpdateBanner />);
  await screen.findByRole("status");

  rig.push(null);

  expect(screen.queryByRole("status")).toBeNull();
});

it("banner_dismiss_hides_it_until_a_newer_version_arrives", async () => {
  const rig = installApi({ version: "99.0.0" });
  render(<UpdateBanner />);

  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("status")).toBeNull();

  rig.push({ version: "99.0.0" });
  expect(screen.queryByRole("status")).toBeNull();

  rig.push({ version: "99.1.0" });
  expect((await screen.findByRole("status")).textContent).toContain(
    "Codeweave 99.1.0 is available.",
  );
});

it("settings_dialog_toggles_update_check", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Check for updates" }),
  );

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { updateCheck: false },
    });
  });
});

it("settings_dialog_picks_update_channel", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  fireEvent.click(
    await screen.findByRole("radio", { name: "Beta (pre-releases)" }),
  );

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { updateChannel: "beta" },
    });
  });
});

it("settings_dialog_disables_channel_when_checks_are_off", async () => {
  const client = settingsClient({ updateCheck: false });
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  const stable = await screen.findByRole("radio", { name: "Stable" });
  const beta = screen.getByRole("radio", { name: "Beta (pre-releases)" });

  expect(stable.hasAttribute("disabled")).toBe(true);
  expect(beta.hasAttribute("disabled")).toBe(true);
});
