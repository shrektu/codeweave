import type { MessageView, SessionView } from "../shared/views";

import type { SessionService } from "./session";

export type NodeOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

export interface TurnWatch {
  readonly outcome: Promise<NodeOutcome>;
  readonly dispose: () => void;
}

type Judgement = NodeOutcome | "wait" | "recheck";

const RECHECK_MS = 10;
const MESSAGE_SEPARATOR = "\n\n";
const NO_MESSAGE_SEQ = -1;
const SESSION_ENDED_MESSAGE = "The session ended before the node finished";
const SESSION_STOPPED_MESSAGE = "The session was stopped";
const SESSION_HALTED_MESSAGE = "No account could continue the session";

export function failure(message: string): NodeOutcome {
  return { ok: false, message };
}

export function highestSeq(messages: readonly MessageView[]): number {
  return Math.max(NO_MESSAGE_SEQ, ...messages.map((message) => message.seq));
}

function textAfter(messages: readonly MessageView[], seq: number): string {
  return messages
    .filter((message) => message.seq > seq)
    .map((message) => message.text)
    .join(MESSAGE_SEPARATOR);
}

function judgePhase(phase: SessionView["phase"]): Judgement | null {
  switch (phase.phase) {
    case "failed":
      return failure(`The session failed: ${phase.reason}`);
    case "halted":
      return failure(SESSION_HALTED_MESSAGE);
    case "stopped":
      return failure(SESSION_STOPPED_MESSAGE);
    case "switching":
    case "waiting":
      return "wait";
    case "running":
      return null;
  }
}

function judge(
  view: SessionView | null,
  baseline: number,
  settled: boolean,
): Judgement {
  if (view === null) {
    return failure(SESSION_ENDED_MESSAGE);
  }
  const { lastTurn } = view;
  const byPhase = judgePhase(view.phase);
  if (byPhase !== null) {
    return byPhase;
  }
  if (lastTurn === null || view.turnInFlight) {
    return "wait";
  }
  if (!settled) {
    return "recheck";
  }
  return lastTurn.kind === "failed"
    ? failure(lastTurn.message)
    : { ok: true, text: textAfter(view.messages, baseline) };
}

export function watchTurn(
  sessions: SessionService,
  baseline: number,
): TurnWatch {
  const { promise, resolve } = Promise.withResolvers<NodeOutcome>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const check = (view: SessionView | null): void => {
    clearTimeout(timer);
    if (closed) {
      return;
    }
    const judgement = judge(view, baseline, sessions.isSettled());
    if (judgement === "recheck") {
      timer = setTimeout(() => {
        check(sessions.view());
      }, RECHECK_MS);
    } else if (judgement !== "wait") {
      closed = true;
      resolve(judgement);
    }
  };
  const unsubscribe = sessions.onViewChanged(check);
  return {
    outcome: promise,
    dispose: () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
    },
  };
}
