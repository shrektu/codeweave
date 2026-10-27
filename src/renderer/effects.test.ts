import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIN_FULL_EFFECTS_FPS,
  chooseEffectLevel,
  measureFps,
  type EffectLevel,
} from "./effects";

describe("chooseEffectLevel", () => {
  it("manual_low_wins_over_gpu_and_high_fps", () => {
    expect(
      chooseEffectLevel({
        gpuAccelerated: true,
        measuredFps: 120,
        manual: "low",
      }),
    ).toBe("low");
  });

  it("manual_full_wins_without_gpu_and_low_fps", () => {
    expect(
      chooseEffectLevel({
        gpuAccelerated: false,
        measuredFps: 5,
        manual: "full",
      }),
    ).toBe("full");
  });

  it("no_gpu_means_low", () => {
    expect(
      chooseEffectLevel({
        gpuAccelerated: false,
        measuredFps: 120,
        manual: undefined,
      }),
    ).toBe("low");
  });

  it.each<[string, number, EffectLevel]>([
    ["just below the threshold", MIN_FULL_EFFECTS_FPS - 0.1, "low"],
    ["exactly at the threshold", MIN_FULL_EFFECTS_FPS, "full"],
    ["well above the threshold", MIN_FULL_EFFECTS_FPS * 2, "full"],
    ["zero fps", 0, "low"],
    ["NaN fps", Number.NaN, "low"],
  ])("measured_fps_%s", (_label, measuredFps, expected) => {
    expect(
      chooseEffectLevel({
        gpuAccelerated: true,
        measuredFps,
        manual: undefined,
      }),
    ).toBe(expected);
  });

  it("unmeasured_fps_with_gpu_means_full", () => {
    expect(
      chooseEffectLevel({
        gpuAccelerated: true,
        measuredFps: undefined,
        manual: undefined,
      }),
    ).toBe("full");
  });
});

function stubAnimationFrames(timestamps: number[]): void {
  const deliver = (callback: FrameRequestCallback, timestamp: number): void => {
    callback(timestamp);
  };
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => {
      const timestamp = timestamps.shift();
      if (timestamp !== undefined) {
        queueMicrotask(deliver.bind(undefined, callback, timestamp));
      }
      return 0;
    },
  );
}

describe("measureFps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports_frames_per_second_over_the_window", async () => {
    stubAnimationFrames(Array.from({ length: 51 }, (_, index) => index * 20));

    await expect(measureFps(1000)).resolves.toBe(50);
  });
});
