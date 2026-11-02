import {
  TERMINAL_HIGH_WATERMARK_CHARS,
  TERMINAL_LOW_WATERMARK_CHARS,
  TERMINAL_REPLAY_MAX_CHARS,
} from "../constants";

const LINE_BREAK = "\n";
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

export const FlowAction = {
  pause: "pause",
  resume: "resume",
  none: "none",
} as const;
export type FlowAction = (typeof FlowAction)[keyof typeof FlowAction];

function startsInsideSurrogatePair(text: string): boolean {
  const first = text.charCodeAt(0);
  return first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX;
}

function trimToCapacity(text: string): string {
  if (text.length <= TERMINAL_REPLAY_MAX_CHARS) {
    return text;
  }
  const kept = text.slice(text.length - TERMINAL_REPLAY_MAX_CHARS);
  const aligned = startsInsideSurrogatePair(kept) ? kept.slice(1) : kept;
  const lineBreak = aligned.indexOf(LINE_BREAK);
  return lineBreak < 0 ? aligned : aligned.slice(lineBreak + 1);
}

export class ReplayRing {
  private text = "";

  append(chunk: string): void {
    this.text = trimToCapacity(this.text + chunk);
  }

  snapshot(): string {
    return this.text;
  }
}

export class FlowGate {
  private unacked = 0;
  private paused = false;

  onSent(chars: number): FlowAction {
    this.unacked += chars;
    if (!this.paused && this.unacked > TERMINAL_HIGH_WATERMARK_CHARS) {
      this.paused = true;
      return FlowAction.pause;
    }
    return FlowAction.none;
  }

  onAck(chars: number): FlowAction {
    this.unacked = Math.max(0, this.unacked - chars);
    if (this.paused && this.unacked < TERMINAL_LOW_WATERMARK_CHARS) {
      this.paused = false;
      return FlowAction.resume;
    }
    return FlowAction.none;
  }

  reset(): FlowAction {
    const wasPaused = this.paused;
    this.unacked = 0;
    this.paused = false;
    return wasPaused ? FlowAction.resume : FlowAction.none;
  }
}
