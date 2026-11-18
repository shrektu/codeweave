import {
  PS_BINARY,
  PS_CALL_TIMEOUT_MS,
  PS_ENV,
  PS_TABLE_ARGS,
  RUN_ID_ENV,
} from "../constants";
import { execText, type ExecText } from "../exec";

import type { ProcessEntry, ProcessTable } from "./marker";

const PS_LINE_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.*)$/;
const START_TIME_SEPARATOR = " ";
const MARKER_TOKEN_PATTERN = new RegExp(`(?:^|\\s)${RUN_ID_ENV}=(\\S+)`, "g");
const LINE_BREAK_PATTERN = /\r?\n/;
const CONTINUATION_SEPARATOR = "\n";

interface RawEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly identity: string;
  readonly lines: string[];
}

function lastMarker(text: string): string | null {
  const tokens = [...text.matchAll(MARKER_TOKEN_PATTERN)];
  return tokens.at(-1)?.[1] ?? null;
}

function toEntry(raw: RawEntry): ProcessEntry {
  return {
    pid: raw.pid,
    ppid: raw.ppid,
    marker: lastMarker(raw.lines.join(CONTINUATION_SEPARATOR)),
    identity: raw.identity,
  };
}

export function parsePsTable(output: string): ProcessEntry[] {
  const raws: RawEntry[] = [];
  for (const line of output.split(LINE_BREAK_PATTERN)) {
    const [, pid, ppid, ...tokens] = PS_LINE_PATTERN.exec(line) ?? [];
    const rest = tokens.pop();
    if (pid !== undefined && ppid !== undefined && rest !== undefined) {
      raws.push({
        pid: Number(pid),
        ppid: Number(ppid),
        identity: tokens.join(START_TIME_SEPARATOR),
        lines: [rest],
      });
    } else if (line !== "") {
      raws.at(-1)?.lines.push(line);
    }
  }
  return raws.map(toEntry);
}

export function createPsProcessTable(exec: ExecText = execText): ProcessTable {
  return {
    async list(): Promise<readonly ProcessEntry[]> {
      const stdout = await exec(PS_BINARY, PS_TABLE_ARGS, {
        timeoutMs: PS_CALL_TIMEOUT_MS,
        env: PS_ENV,
      });
      return parsePsTable(stdout);
    },
  };
}
