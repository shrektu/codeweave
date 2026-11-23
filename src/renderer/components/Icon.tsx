import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";

export const ICON_SIZE_PX = 16;
export const ICON_SIZE_SMALL_PX = 14;
export const ICON_STROKE_WIDTH = 1.75;

interface IconProps {
  icon: LucideIcon;
  size?: number;
}

export function Icon({
  icon: Glyph,
  size = ICON_SIZE_PX,
}: IconProps): JSX.Element {
  return (
    <Glyph size={size} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
  );
}
