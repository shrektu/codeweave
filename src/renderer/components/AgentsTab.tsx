import { useState, type JSX } from "react";

import type { AgentView, FlowFileError, FlowsList } from "../../shared/views";
import { isAgentDraftChanged } from "../agentDraft";
import { PROVIDER_LABELS } from "../format";
import type { AgentEditor, AgentSession } from "../useAgentEditor";
import { useFlowsLoad, type FlowsSource } from "../useFlowsLoad";

import { AgentForm } from "./AgentForm";
import { Dialog } from "./Dialog";
import { FlowErrors } from "./FlowErrors";
import { FolderPrompt, PickFolderButton } from "./FolderControls";

const AGENT_FILE_PREFIX = "agents/";
const MISSING_MESSAGE = "This agent is no longer on disk.";

function isAgentFileError(error: FlowFileError): boolean {
  return error.file.startsWith(AGENT_FILE_PREFIX);
}

type Choice = { kind: "new" } | { kind: "open"; id: string };

function AgentList({
  agents,
  selectedId,
  isNew,
  onChoose,
}: {
  agents: readonly AgentView[];
  selectedId: string | null;
  isNew: boolean;
  onChoose: (choice: Choice) => void;
}): JSX.Element {
  return (
    <div className="agent-list-pane">
      <button
        type="button"
        className="btn pri"
        aria-pressed={isNew}
        onClick={() => {
          onChoose({ kind: "new" });
        }}
      >
        New agent
      </button>
      {agents.length === 0 && <p className="empty">No agents found.</p>}
      <ul className="agent-list" aria-label="Agents">
        {agents.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              className="agent-row"
              aria-current={agent.id === selectedId ? "true" : undefined}
              onClick={() => {
                onChoose({ kind: "open", id: agent.id });
              }}
            >
              <span className="agent-id">{agent.id}</span>{" "}
              <span className="agent-role">{agent.role}</span>{" "}
              <span className="agent-provider">
                {PROVIDER_LABELS[agent.provider]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiscardDialog({
  onDiscard,
  onClose,
}: {
  onDiscard: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog title="Discard unsaved changes?" onClose={onClose}>
      <p>Your edits to this agent will be lost.</p>
      <div className="dialog-actions">
        <button type="button" className="btn pri" onClick={onDiscard}>
          Discard changes
        </button>
      </div>
    </Dialog>
  );
}

function applyChoice(
  list: FlowsList,
  editor: AgentEditor,
  choice: Choice,
): void {
  if (choice.kind === "new") {
    editor.startNew();
    return;
  }
  const target = list.agents.find((agent) => agent.id === choice.id);
  if (target !== undefined) {
    editor.open(target);
  }
}

function AgentDetail({
  list,
  editor,
  source,
  view,
  missing,
}: {
  list: FlowsList;
  editor: AgentEditor;
  source: FlowsSource;
  view: AgentView | null;
  missing: boolean;
}): JSX.Element {
  const { session } = editor;
  if (session === null) {
    return <p className="empty">Select an agent or create a new one.</p>;
  }
  if (missing) {
    return <p className="error">{MISSING_MESSAGE}</p>;
  }
  return (
    <AgentForm
      list={list}
      session={session}
      view={view}
      saving={editor.saving}
      error={editor.error}
      onChange={editor.setDraft}
      onSave={() => {
        editor.save(source.replace);
      }}
      onDiscard={() => {
        applyChoice(
          list,
          editor,
          view === null ? { kind: "new" } : { kind: "open", id: view.id },
        );
      }}
      onDelete={() => {
        editor.remove(source.replace);
      }}
      onReload={() => {
        editor.reload(source.replace);
      }}
    />
  );
}

function isDirty(
  session: AgentSession | null,
  view: AgentView | null,
): boolean {
  const known = session?.target.kind === "new" || view !== null;
  return session !== null && known && isAgentDraftChanged(session.draft, view);
}

function AgentsWorkspace({
  list,
  editor,
  source,
}: {
  list: FlowsList;
  editor: AgentEditor;
  source: FlowsSource;
}): JSX.Element {
  const [pending, setPending] = useState<Choice | null>(null);
  const { session } = editor;
  const targetId =
    session?.target.kind === "existing" ? session.target.id : null;
  const view = list.agents.find((agent) => agent.id === targetId) ?? null;
  const missing = targetId !== null && view === null;

  const choose = (choice: Choice): void => {
    if (choice.kind === "open" && choice.id === targetId) {
      return;
    }
    if (isDirty(session, view)) {
      setPending(choice);
    } else {
      applyChoice(list, editor, choice);
    }
  };

  return (
    <>
      <div className="agents-layout">
        <AgentList
          agents={list.agents}
          selectedId={targetId}
          isNew={session?.target.kind === "new"}
          onChoose={choose}
        />
        <div className="agent-detail">
          <AgentDetail
            list={list}
            editor={editor}
            source={source}
            view={view}
            missing={missing}
          />
        </div>
      </div>
      <FlowErrors errors={list.errors.filter(isAgentFileError)} />
      {pending !== null && (
        <DiscardDialog
          onDiscard={() => {
            applyChoice(list, editor, pending);
            setPending(null);
          }}
          onClose={() => {
            setPending(null);
          }}
        />
      )}
    </>
  );
}

function AgentsBody({
  cwd,
  editor,
  source,
  onPickFolder,
}: {
  cwd: string | null;
  editor: AgentEditor;
  source: FlowsSource;
  onPickFolder: (cwd: string) => void;
}): JSX.Element {
  const { load } = source;
  if (cwd === null) {
    return <FolderPrompt subject="agents" onPick={onPickFolder} />;
  }
  switch (load.status) {
    case "loading":
      return <p className="empty">Loading agents…</p>;
    case "failed":
      return <p className="error">{load.message}</p>;
    case "ready":
      return (
        <AgentsWorkspace list={load.list} editor={editor} source={source} />
      );
  }
}

export function AgentsTab({
  cwd,
  editor,
  folderPinned,
  onPickFolder,
}: {
  cwd: string | null;
  editor: AgentEditor;
  folderPinned: boolean;
  onPickFolder: (cwd: string) => void;
}): JSX.Element {
  const source = useFlowsLoad(cwd);

  return (
    <section className="glass panel agents-tab" aria-label="Agents">
      <h2 className="sec">Agents</h2>
      {cwd !== null && !folderPinned && (
        <PickFolderButton
          label="Change folder…"
          primary={false}
          onPick={onPickFolder}
        />
      )}
      <AgentsBody
        cwd={cwd}
        editor={editor}
        source={source}
        onPickFolder={onPickFolder}
      />
    </section>
  );
}
