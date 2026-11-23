import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { JSX, ReactNode } from "react";

import { ICON_SIZE_SMALL_PX, Icon } from "./Icon";

export const StatusTone = {
  neutral: "neutral",
  active: "active",
  waiting: "waiting",
  success: "success",
  danger: "danger",
} as const;
export type StatusTone = (typeof StatusTone)[keyof typeof StatusTone];

const TONE_ICONS: Readonly<Record<StatusTone, LucideIcon>> = {
  [StatusTone.neutral]: CircleDashed,
  [StatusTone.active]: LoaderCircle,
  [StatusTone.waiting]: Clock,
  [StatusTone.success]: CircleCheck,
  [StatusTone.danger]: CircleAlert,
};

interface StatusPillProps {
  tone: StatusTone;
  className?: string;
  children: ReactNode;
}

export function StatusPill({
  tone,
  className,
  children,
}: StatusPillProps): JSX.Element {
  return (
    <span
      className={`status-pill${className === undefined ? "" : ` ${className}`}`}
      data-tone={tone}
    >
      <Icon icon={TONE_ICONS[tone]} size={ICON_SIZE_SMALL_PX} />
      {children}
    </span>
  );
}
