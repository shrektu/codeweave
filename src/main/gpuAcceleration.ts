export const GPU_COMPOSITING_ENABLED_PREFIX = "enabled";

export interface GpuStatusSource {
  compositingStatus(): string;
  onInfoUpdate(listener: () => void): void;
}

export function isGpuAccelerated(source: GpuStatusSource): boolean {
  return source.compositingStatus().startsWith(GPU_COMPOSITING_ENABLED_PREFIX);
}

export function watchGpuAcceleration(
  source: GpuStatusSource,
  onChanged: (accelerated: boolean) => void,
): void {
  let last = isGpuAccelerated(source);
  source.onInfoUpdate(() => {
    const next = isGpuAccelerated(source);
    if (next !== last) {
      last = next;
      onChanged(next);
    }
  });
}
