import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createSettingsService } from "../../src/backend/settingsService";
import { createJsonStore } from "../../src/backend/storage";
import { IpcError, IpcErrorCode } from "../../src/shared/protocol";
import {
  closeRigs,
  openRig,
  ACCOUNT_A,
  type BackendRig,
} from "../fakes/backendRig";
import { makeTempDir } from "../fakes/processHelpers";

const SETTINGS_FILE = "settings.json";
const BASE_SETTINGS =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null';
const DEFAULT_WORKSPACE_MISSING_PREFIX = "Default workspace does not exist: ";

afterEach(closeRigs);

interface Rig {
  readonly backend: BackendRig;
  readonly home: string;
}

async function createRig(defaultWorkspace?: string | null): Promise<Rig> {
  const userData = await makeTempDir();
  const home = await makeTempDir();
  const settings =
    defaultWorkspace === undefined
      ? `${BASE_SETTINGS}}`
      : `${BASE_SETTINGS},"defaultWorkspace":${JSON.stringify(defaultWorkspace)}}`;
  await writeFile(join(userData, SETTINGS_FILE), settings);
  const backend = await openRig({
    userData,
    homeDir: home,
    accounts: [ACCOUNT_A],
  });
  return { backend, home };
}

async function failureOf(call: () => unknown): Promise<IpcError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof IpcError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
}

it("session-start-default-workspace-used", async () => {
  const workspace = await makeTempDir();
  const rig = await createRig(workspace);

  const view = await rig.backend.call("session/start", {});

  expect(view.cwd).toBe(workspace);
});

it("session-start-falls-back-to-home-when-unset", async () => {
  const rig = await createRig();

  const view = await rig.backend.call("session/start", {});

  expect(view.cwd).toBe(rig.home);
});

it("session-start-explicit-cwd-wins-over-default-workspace", async () => {
  const workspace = await makeTempDir();
  const explicit = await makeTempDir();
  const rig = await createRig(workspace);

  const view = await rig.backend.call("session/start", { cwd: explicit });

  expect(view.cwd).toBe(explicit);
});

it("session-start-default-workspace-missing", async () => {
  const workspace = await makeTempDir();
  const missing = join(workspace, "gone");
  const rig = await createRig(missing);

  const error = await failureOf(() => rig.backend.call("session/start", {}));

  expect(error.code).toBe(IpcErrorCode.VALIDATION);
  expect(error.message).toBe(`${DEFAULT_WORKSPACE_MISSING_PREFIX}${missing}`);
  expect(rig.backend.container.agents).toEqual([]);
});

it("session-start-default-workspace-is-a-file", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "notes.txt");
  await writeFile(file, "x");
  const rig = await createRig(file);

  const error = await failureOf(() => rig.backend.call("session/start", {}));

  expect(error.code).toBe(IpcErrorCode.VALIDATION);
  expect(error.message).toBe(`${DEFAULT_WORKSPACE_MISSING_PREFIX}${file}`);
  expect(rig.backend.container.agents).toEqual([]);
});

it("session-start-default-workspace-symlink-to-directory", async () => {
  const dir = await makeTempDir();
  const target = join(dir, "real");
  const link = join(dir, "link");
  await mkdir(target);
  await symlink(target, link, "dir");
  const rig = await createRig(link);

  const view = await rig.backend.call("session/start", {});

  expect(view.cwd).toBe(link);
});

it("session-start-default-workspace-trailing-slash", async () => {
  const workspace = await makeTempDir();
  const withSlash = `${workspace}/`;
  const rig = await createRig(withSlash);

  const view = await rig.backend.call("session/start", {});

  expect(view.cwd).toBe(withSlash);
});

it("session-start-failure-frees-the-session-slot", async () => {
  const workspace = await makeTempDir();
  const rig = await createRig(join(workspace, "gone"));
  await failureOf(() => rig.backend.call("session/start", {}));

  const view = await rig.backend.call("session/start", { cwd: workspace });

  expect(view.cwd).toBe(workspace);
});

async function settingsServiceFor(
  home: string,
): Promise<ReturnType<typeof createSettingsService>> {
  const dir = await makeTempDir();
  await writeFile(join(dir, SETTINGS_FILE), `${BASE_SETTINGS}}`);
  return createSettingsService({
    store: createJsonStore(dir),
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
    homeDir: home,
  });
}

it("default-workspace-view-resolves-to-home-when-unset", async () => {
  const home = await makeTempDir();
  const service = await settingsServiceFor(home);

  const view = await service.get();

  expect(view.defaultWorkspace).toBeNull();
  expect(view.defaultWorkspaceResolved).toBe(home);
});

it("default-workspace-round-trips-through-settings", async () => {
  const home = await makeTempDir();
  const workspace = await makeTempDir();
  const service = await settingsServiceFor(home);

  const afterSet = await service.set({ defaultWorkspace: workspace });
  const reloaded = await service.get();

  expect(afterSet.defaultWorkspace).toBe(workspace);
  expect(afterSet.defaultWorkspaceResolved).toBe(workspace);
  expect(reloaded.defaultWorkspace).toBe(workspace);
});

it("default-workspace-expands-tilde", async () => {
  const home = await makeTempDir();
  const service = await settingsServiceFor(home);

  const view = await service.set({ defaultWorkspace: "~/projects" });

  expect(view.defaultWorkspace).toBe(join(home, "projects"));
  expect(view.defaultWorkspaceResolved).toBe(join(home, "projects"));
});

it("default-workspace-relative-is-rejected", async () => {
  const service = await settingsServiceFor(await makeTempDir());

  const error = await failureOf(() =>
    service.set({ defaultWorkspace: "relative/dir" }),
  );

  expect(error.code).toBe(IpcErrorCode.VALIDATION);
});

it.each(["", "   ", null])(
  "default-workspace-blank-%j-resets-to-home",
  async (blank) => {
    const home = await makeTempDir();
    const workspace = await makeTempDir();
    const service = await settingsServiceFor(home);
    await service.set({ defaultWorkspace: workspace });

    const view = await service.set({ defaultWorkspace: blank });

    expect(view.defaultWorkspace).toBeNull();
    expect(view.defaultWorkspaceResolved).toBe(home);
  },
);

it("settings-set-without-default-workspace-keeps-it", async () => {
  const workspace = await makeTempDir();
  const service = await settingsServiceFor(await makeTempDir());
  await service.set({ defaultWorkspace: workspace });

  const view = await service.set({ effectLevel: "full" });

  expect(view.defaultWorkspace).toBe(workspace);
});

it("flow-library-keeps-its-own-relative-message", async () => {
  const service = await settingsServiceFor(await makeTempDir());

  const error = await failureOf(() =>
    service.set({ definitionLibrary: "relative/lib" }),
  );

  expect(error.message).toBe(
    "The agents and flows library must be an absolute path",
  );
});
