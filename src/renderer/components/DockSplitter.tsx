import {
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { DOCK_MIN_HEIGHT_PX } from "../terminal/dockSize";

const DOCK_KEYBOARD_STEP_PX = 24;
const KEY_STEPS: Readonly<Record<string, number>> = {
  ArrowUp: DOCK_KEYBOARD_STEP_PX,
  ArrowDown: -DOCK_KEYBOARD_STEP_PX,
};

interface DragStart {
  pointerY: number;
  height: number;
}

interface DockSplitterProps {
  height: number;
  onResize: (height: number) => void;
}

export function DockSplitter({
  height,
  onResize,
}: DockSplitterProps): JSX.Element {
  const [drag, setDrag] = useState<DragStart | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = KEY_STEPS[event.key];
    if (step !== undefined) {
      event.preventDefault();
      onResize(height + step);
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag !== null) {
      onResize(drag.height + drag.pointerY - event.clientY);
    }
  };
  const endDrag = (): void => {
    setDrag(null);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      aria-valuemin={DOCK_MIN_HEIGHT_PX}
      aria-valuenow={height}
      tabIndex={0}
      className="terminal-splitter"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ pointerY: event.clientY, height });
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
