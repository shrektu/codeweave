import { useEffect, useState } from "react";

export const DOCK_STORAGE_KEY = "codeweave.terminalDock";
const DOCK_OPEN_VALUE = "open";
const DOCK_CLOSED_VALUE = "closed";
const TOGGLE_KEY_CODE = "Backquote";

export interface TerminalDockState {
  open: boolean;
  toggle: () => void;
  hide: () => void;
}

function readDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_STORAGE_KEY) === DOCK_OPEN_VALUE;
  } catch (error: unknown) {
    console.warn("Terminal dock state could not be read", error);
    return false;
  }
}

function writeDockOpen(open: boolean): void {
  try {
    localStorage.setItem(
      DOCK_STORAGE_KEY,
      open ? DOCK_OPEN_VALUE : DOCK_CLOSED_VALUE,
    );
  } catch (error: unknown) {
    console.warn("Terminal dock state could not be saved", error);
  }
}

function isToggleShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === TOGGLE_KEY_CODE &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export function useTerminalDock(): TerminalDockState {
  const [open, setOpen] = useState(readDockOpen);

  useEffect(() => {
    writeDockOpen(open);
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isToggleShortcut(event)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return {
    open,
    toggle: () => {
      setOpen((previous) => !previous);
    },
    hide: () => {
      setOpen(false);
    },
  };
}
