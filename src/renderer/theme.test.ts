import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Appearance } from "../domain/types";

import {
  APPEARANCE_STORAGE_KEY,
  readStoredAppearance,
  resolveTheme,
  storeAppearance,
  useResolvedTheme,
} from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("stored appearance", () => {
  it("launch_theme_flash_stored_appearance_round_trips", () => {
    expect(readStoredAppearance()).toBeNull();

    storeAppearance(Appearance.dark);

    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(readStoredAppearance()).toBe("dark");
  });

  it("launch_theme_flash_invalid_stored_value_is_null", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "sepia");

    expect(readStoredAppearance()).toBeNull();
  });

  it("launch_theme_flash_throwing_storage_is_null", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(readStoredAppearance()).toBeNull();
    expect(() => {
      storeAppearance(Appearance.light);
    }).not.toThrow();
  });
});

describe("resolveTheme", () => {
  it.each<[Appearance, boolean, "light" | "dark"]>([
    ["system", true, "dark"],
    ["system", false, "light"],
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
  ])("%s with prefersDark=%s is %s", (appearance, prefersDark, expected) => {
    expect(resolveTheme(appearance, prefersDark)).toBe(expected);
  });
});

describe("useResolvedTheme", () => {
  it("theme_defaults_to_dark_without_matchmedia", () => {
    vi.stubGlobal("matchMedia", undefined);

    const { result } = renderHook(() => useResolvedTheme(Appearance.system));

    expect(result.current).toBe("dark");
  });

  it("reads_the_system_preference_for_system", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );

    const { result } = renderHook(() => useResolvedTheme(Appearance.system));

    expect(result.current).toBe("light");
  });

  it("does_not_subscribe_when_appearance_is_explicit", () => {
    const addEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener,
        removeEventListener: () => undefined,
      })),
    );

    const { result } = renderHook(() => useResolvedTheme(Appearance.light));

    expect(result.current).toBe("light");
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
