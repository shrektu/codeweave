import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "../../shared/constants";

export interface TerminalSize {
  cols: number;
  rows: number;
}

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

function bound(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function boundTerminalSize({ cols, rows }: TerminalSize): TerminalSize {
  return {
    cols: bound(cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
    rows: bound(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
  };
}

export function isSameSize(a: TerminalSize | null, b: TerminalSize): boolean {
  return a?.cols === b.cols && a.rows === b.rows;
}
