export type EffectLevel = "low" | "full";

export const MIN_FULL_EFFECTS_FPS = 45;
export const FPS_MEASURE_DURATION_MS = 1000;
const MS_PER_SECOND = 1000;

export interface EffectInputs {
  gpuAccelerated: boolean;
  measuredFps: number | undefined;
  manual: EffectLevel | undefined;
}

function isSmooth(fps: number): boolean {
  return fps >= MIN_FULL_EFFECTS_FPS;
}

export function chooseEffectLevel({
  gpuAccelerated,
  measuredFps,
  manual,
}: EffectInputs): EffectLevel {
  if (manual !== undefined) {
    return manual;
  }
  if (!gpuAccelerated) {
    return "low";
  }
  if (measuredFps !== undefined && !isSmooth(measuredFps)) {
    return "low";
  }
  return "full";
}

export function measureFps(durationMs: number): Promise<number> {
  return new Promise((resolve) => {
    let frames = 0;
    let start: number | undefined;
    const onFrame = (now: number): void => {
      if (start === undefined) {
        start = now;
      } else {
        frames += 1;
      }
      const elapsed = now - start;
      if (elapsed >= durationMs) {
        resolve((frames * MS_PER_SECOND) / elapsed);
        return;
      }
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  });
}
