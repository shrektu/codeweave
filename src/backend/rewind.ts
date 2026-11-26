import { RewindMode } from "../domain/checkpoints";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type {
  PromptView,
  RestorePlanView,
  RewindResultView,
  SessionView,
} from "../shared/views";

import type { CheckpointStore } from "./checkpointStore";
import { FLOW_RUNNING_MESSAGE } from "./constants";
import type { SessionHistory } from "./sessionHistory";
import type { SessionService } from "./session";
import type { SessionPool } from "./sessionPool";

const SESSION_NOT_FOUND_MESSAGE = "Session not found";
const PROMPT_NOT_FOUND_MESSAGE = "Prompt not found";
const TURN_IN_FLIGHT_MESSAGE = "Stop the agent before rewinding";

export interface RewindServiceDeps {
  readonly sessions: Pick<SessionPool, "main" | "closeMain">;
  readonly history: Pick<SessionHistory, "get" | "flush" | "truncate">;
  readonly checkpoints: Pick<CheckpointStore, "plan" | "restore" | "fold">;
  readonly hasOpenFlowRuns: () => boolean;
  readonly resume: (sessionId: string) => Promise<SessionView>;
}

export interface RewindService {
  preview(params: ParamsMap["session/rewindPreview"]): Promise<RestorePlanView>;
  rewind(params: ParamsMap["session/rewind"]): Promise<RewindResultView>;
}

function promptOf(
  prompts: readonly PromptView[],
  promptSeq: number,
): PromptView {
  const prompt = prompts.find((entry) => entry.seq === promptSeq);
  if (prompt === undefined) {
    throw new IpcError(IpcErrorCode.NOT_FOUND, PROMPT_NOT_FOUND_MESSAGE);
  }
  return prompt;
}

async function findPrompt(
  deps: RewindServiceDeps,
  sessionId: string,
  promptSeq: number,
  live: SessionService | null,
): Promise<PromptView> {
  const livePrompts = live?.view()?.prompts;
  if (livePrompts !== undefined) {
    return promptOf(livePrompts, promptSeq);
  }
  const stored = await deps.history.get(sessionId);
  return promptOf(stored?.prompts ?? [], promptSeq);
}

async function rewindConversation(
  deps: RewindServiceDeps,
  params: ParamsMap["session/rewind"],
  live: SessionService | null,
): Promise<SessionView | null> {
  const wasLive = live?.isLive() === true;
  if (live !== null) {
    if (live.isLive()) {
      await live.stop();
    }
    await deps.sessions.closeMain(params.sessionId);
  }
  await deps.history.flush();
  const stored = await deps.history.truncate(
    params.sessionId,
    params.promptSeq,
  );
  if (stored === null) {
    throw new IpcError(IpcErrorCode.NOT_FOUND, SESSION_NOT_FOUND_MESSAGE);
  }
  const intoSeq = stored.prompts.at(-1)?.seq ?? -1;
  await deps.checkpoints.fold(params.sessionId, params.promptSeq, intoSeq);
  return wasLive ? deps.resume(params.sessionId) : null;
}

export function createRewindService(deps: RewindServiceDeps): RewindService {
  async function preview(
    params: ParamsMap["session/rewindPreview"],
  ): Promise<RestorePlanView> {
    const live = deps.sessions.main(params.sessionId);
    await findPrompt(deps, params.sessionId, params.promptSeq, live);
    return deps.checkpoints.plan(params.sessionId, params.promptSeq);
  }

  async function rewind(
    params: ParamsMap["session/rewind"],
  ): Promise<RewindResultView> {
    const live = deps.sessions.main(params.sessionId);
    if (live?.view()?.turnInFlight === true) {
      throw new IpcError(IpcErrorCode.CONFLICT, TURN_IN_FLIGHT_MESSAGE);
    }
    if (deps.hasOpenFlowRuns()) {
      throw new IpcError(IpcErrorCode.CONFLICT, FLOW_RUNNING_MESSAGE);
    }
    const prompt = await findPrompt(
      deps,
      params.sessionId,
      params.promptSeq,
      live,
    );
    const report =
      params.mode === RewindMode.conversation
        ? null
        : await deps.checkpoints.restore(
            params.sessionId,
            params.promptSeq,
            params.overwrite,
          );
    const session =
      params.mode === RewindMode.files
        ? null
        : await rewindConversation(deps, params, live);
    return { promptText: prompt.text, report, session };
  }

  return { preview, rewind };
}
