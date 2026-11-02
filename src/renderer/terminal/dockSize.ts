export const DOCK_MIN_HEIGHT_PX = 120;
export const DOCK_MAX_FRACTION = 0.7;
export const DOCK_DEFAULT_HEIGHT_PX = 280;

export function clampDockHeight(height: number, columnHeight: number): number {
  const wanted = Number.isFinite(height) ? height : DOCK_DEFAULT_HEIGHT_PX;
  const measured = Number.isFinite(columnHeight) && columnHeight > 0;
  const max = measured
    ? Math.max(DOCK_MIN_HEIGHT_PX, columnHeight * DOCK_MAX_FRACTION)
    : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(wanted, DOCK_MIN_HEIGHT_PX), max);
}
