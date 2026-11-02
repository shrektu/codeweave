import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAgyIsolation } from "../e2e/agyRotationFixture";

import {
  assertIsolatedAgyEnv,
  ISOLATED_DBUS_ADDRESS,
  type AgyEnvIsolation,
} from "./agyHomeGuard";

const SAFE_HOME = join(tmpdir(), "agy-guard-home");
const SAFE: AgyEnvIsolation = {
  home: SAFE_HOME,
  geminiDir: join(SAFE_HOME, "accounts", "a"),
  baseUrl: "http://127.0.0.1:4321",
  dbusAddress: "unix:path=/nonexistent",
  xdgDirs: {
    XDG_CONFIG_HOME: join(SAFE_HOME, ".config"),
    XDG_CACHE_HOME: join(SAFE_HOME, ".cache"),
    XDG_DATA_HOME: join(SAFE_HOME, ".local", "share"),
    XDG_STATE_HOME: join(SAFE_HOME, ".local", "state"),
  },
};

describe("assertIsolatedAgyEnv", () => {
  it("accepts_a_temporary_home_loopback_url_and_dead_dbus", () => {
    expect(() => {
      assertIsolatedAgyEnv(SAFE);
    }).not.toThrow();
  });

  it("exports_the_dead_dbus_address_it_requires", () => {
    expect(ISOLATED_DBUS_ADDRESS).toBe("unix:path=/nonexistent");
  });

  it("guard_rejects_real_gemini_dir", () => {
    expect(() => {
      assertIsolatedAgyEnv({
        ...SAFE,
        geminiDir: join(homedir(), ".gemini", "antigravity-cli"),
      });
    }).toThrow(/real agy directory/);
  });

  it("guard_rejects_home_inside_real_gemini_dir", () => {
    expect(() => {
      assertIsolatedAgyEnv({ ...SAFE, home: join(homedir(), ".gemini") });
    }).toThrow(/real agy directory/);
  });

  it("guard_rejects_home_outside_tmp", () => {
    expect(() => {
      assertIsolatedAgyEnv({
        ...SAFE,
        home: join(homedir(), "agy-guard-home"),
      });
    }).toThrow(/temporary directory/);
  });

  it.each(Object.keys(SAFE.xdgDirs))(
    "guard_rejects_xdg_outside_tmp_%s",
    (name) => {
      expect(() => {
        assertIsolatedAgyEnv({
          ...SAFE,
          xdgDirs: { ...SAFE.xdgDirs, [name]: join(homedir(), ".config") },
        });
      }).toThrow(new RegExp(`${name}.*temporary directory`));
    },
  );

  it("guard_rejects_gemini_dir_outside_tmp", () => {
    expect(() => {
      assertIsolatedAgyEnv({
        ...SAFE,
        geminiDir: join(homedir(), "agy-guard-gemini"),
      });
    }).toThrow(/temporary directory/);
  });
});

describe("createAgyIsolation", () => {
  it("agy_env_overrides_isolate_xdg", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-xdg-"));
    try {
      const { agentEnv } = await createAgyIsolation(
        root,
        join(root, "gemini"),
        "http://127.0.0.1:4321",
      );
      const home = join(root, "agy-home");

      expect(agentEnv).toMatchObject({
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("assertIsolatedAgyEnv network and keyring", () => {
  it("guard_rejects_non_loopback_base_url", () => {
    expect(() => {
      assertIsolatedAgyEnv({
        ...SAFE,
        baseUrl: "https://generativelanguage.googleapis.com",
      });
    }).toThrow(/127\.0\.0\.1/);
  });

  it("guard_rejects_localhost_name_as_base_url_host", () => {
    expect(() => {
      assertIsolatedAgyEnv({ ...SAFE, baseUrl: "http://localhost:4321" });
    }).toThrow(/127\.0\.0\.1/);
  });

  it("guard_rejects_live_dbus", () => {
    expect(() => {
      assertIsolatedAgyEnv({
        ...SAFE,
        dbusAddress: "unix:path=/run/user/1000/bus",
      });
    }).toThrow(/D-Bus/);
  });

  it("guard_rejects_missing_dbus_address", () => {
    expect(() => {
      assertIsolatedAgyEnv({ ...SAFE, dbusAddress: "" });
    }).toThrow(/D-Bus/);
  });
});
