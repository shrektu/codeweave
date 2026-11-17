import { useState, type Dispatch, type SetStateAction } from "react";

import type { AgentView, FlowsList } from "../shared/views";

import {
  agentDraftOf,
  emptyAgentDraft,
  isAgentDraftChanged,
  toAgentDefinition,
  type AgentDraft,
} from "./agentDraft";
import { requestUnlessConflict } from "./conflictRequest";
import type { IpcClient } from "./ipc";
import { useApp } from "./services";
import { useAsyncAction, type AsyncAction } from "./useAsyncAction";

export type AgentTarget =
  | { kind: "new" }
  | { kind: "existing"; file: string; revision: string; id: string };

export interface AgentSession {
  cwd: string;
  target: AgentTarget;
  saved: AgentView | null;
  draft: AgentDraft;
  conflict: boolean;
  saveToken: symbol | null;
}

export function agentEditorPinsFolder(
  session: AgentSession | null,
  saving: boolean,
): boolean {
  return (
    saving ||
    (session !== null && isAgentDraftChanged(session.draft, session.saved))
  );
}

export interface AgentEditor {
  cwd: string | null;
  session: AgentSession | null;
  saving: boolean;
  error: string | null;
  open: (view: AgentView) => void;
  startNew: () => void;
  close: () => void;
  setDraft: (draft: AgentDraft) => void;
  save: (onList: (list: FlowsList) => void) => void;
  remove: (onList: (list: FlowsList) => void) => void;
  reload: (onList: (list: FlowsList) => void) => void;
}

type Send = (session: AgentSession) => Promise<FlowsList>;
type Settle = (list: FlowsList, started: AgentSession) => AgentSession | null;

function sessionOf(cwd: string, view: AgentView): AgentSession {
  return {
    cwd,
    target: {
      kind: "existing",
      file: view.file,
      revision: view.revision,
      id: view.id,
    },
    saved: view,
    draft: agentDraftOf(view),
    conflict: false,
    saveToken: null,
  };
}

function reopen(list: FlowsList, cwd: string, id: string): AgentSession | null {
  const view = list.agents.find((agent) => agent.id === id);
  return view === undefined ? null : sessionOf(cwd, view);
}

function sendSave(
  client: IpcClient,
  session: AgentSession,
): Promise<FlowsList> {
  const { cwd, target, draft } = session;
  const agent = toAgentDefinition(draft);
  return target.kind === "new"
    ? client.request("agents/create", { cwd, agent, body: draft.body })
    : client.request("agents/save", {
        cwd,
        file: target.file,
        revision: target.revision,
        id: target.id,
        agent,
        body: draft.body,
      });
}

function sendDelete(
  client: IpcClient,
  session: AgentSession,
): Promise<FlowsList> {
  const { cwd, target } = session;
  if (target.kind === "new") {
    return Promise.reject(new Error("A new agent has nothing to delete"));
  }
  return client.request("agents/delete", {
    cwd,
    file: target.file,
    revision: target.revision,
    id: target.id,
  });
}

function reopenSaved(
  list: FlowsList,
  started: AgentSession,
): AgentSession | null {
  return reopen(list, started.cwd, started.draft.id);
}

function reopenOriginal(
  list: FlowsList,
  started: AgentSession,
): AgentSession | null {
  return started.target.kind === "new"
    ? null
    : reopen(list, started.cwd, started.target.id);
}

function closeEditor(): null {
  return null;
}

function newSession(cwd: string): AgentSession {
  return {
    cwd,
    target: { kind: "new" },
    saved: null,
    draft: emptyAgentDraft(),
    conflict: false,
    saveToken: null,
  };
}

type Perform = (
  send: Send,
  settle: Settle,
  onList: (list: FlowsList) => void,
) => void;

function performerFor(
  session: AgentSession | null,
  setStored: Dispatch<SetStateAction<AgentSession | null>>,
  busy: AsyncAction,
): Perform {
  return (send, settle, onList) => {
    if (session === null) {
      return;
    }
    const token = Symbol("agent-request");
    const started = { ...session, conflict: false, saveToken: token };
    setStored(started);
    void busy.run(async () => {
      const list = await requestUnlessConflict(
        () => send(started),
        () => {
          setStored((current) =>
            current?.saveToken === token
              ? { ...current, conflict: true, saveToken: null }
              : current,
          );
        },
      );
      if (list === null) {
        return;
      }
      onList(list);
      setStored((current) =>
        current?.saveToken === token ? settle(list, started) : current,
      );
    });
  };
}

export function useAgentEditor(autoCwd: string | null): AgentEditor {
  const { client } = useApp();
  const [session, setStored] = useState<AgentSession | null>(null);
  const busy = useAsyncAction();
  const perform = performerFor(session, setStored, busy);
  const cwd = session?.cwd ?? autoCwd;

  const begin = (build: (cwd: string) => AgentSession): void => {
    if (cwd !== null) {
      setStored(build(cwd));
      busy.setError(null);
    }
  };

  return {
    cwd,
    session,
    saving: busy.pending,
    error: busy.error,
    open: (view) => {
      begin((folder) => sessionOf(folder, view));
    },
    startNew: () => {
      begin(newSession);
    },
    close: () => {
      setStored(null);
    },
    setDraft: (draft) => {
      setStored((current) => (current === null ? null : { ...current, draft }));
    },
    save: (onList) => {
      perform((started) => sendSave(client, started), reopenSaved, onList);
    },
    remove: (onList) => {
      perform((started) => sendDelete(client, started), closeEditor, onList);
    },
    reload: (onList) => {
      perform(
        (started) => client.request("flows/list", { cwd: started.cwd }),
        reopenOriginal,
        onList,
      );
    },
  };
}
