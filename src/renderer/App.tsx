import {
  useEffect,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from "react";

import { EffectLevel as EffectSetting } from "../domain/types";
import { IpcErrorCode } from "../shared/protocol";
import type {
  FlowFileError,
  FlowsList,
  FlowView,
  SessionView,
} from "../shared/views";

import { AccountsDialog } from "./components/AccountsDialog";
import { FlowGraph } from "./components/FlowGraph";
import { FlowInspector } from "./components/FlowInspector";
import { LimitsPanel } from "./components/LimitsPanel";
import { SessionStream } from "./components/SessionStream";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SwitchLog } from "./components/SwitchLog";
import { TerminalDock } from "./components/TerminalDock";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  FPS_MEASURE_DURATION_MS,
  chooseEffectLevel,
  measureFps,
} from "./effects";
import { errorMessage } from "./errorMessage";
import {
  baseOf,
  draftErrors,
  draftOf,
  isDraftChanged,
  saveParamsOf,
  type FlowBase,
  type FlowDraft,
  type FlowSelection,
} from "./flowDraft";
import { IpcRemoteError, type IpcClient } from "./ipc";
import { useApp } from "./services";
import { useTerminalDock } from "./terminal/useTerminalDock";
import { useAsyncAction } from "./useAsyncAction";
import { useBackendStatus, type BackendStatus } from "./useBackendStatus";
import { useElementSize } from "./useElementSize";

type OpenDialog = "accounts" | "settings" | null;
type CentreTab = "session" | "flow";

const CENTRE_TABS: readonly { id: CentreTab; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "flow", label: "Flow" },
];

const FLOW_CONFLICT_MESSAGE =
  "This flow changed on disk. Reload to edit the latest version.";
const FLOW_MISSING_MESSAGE = "This flow is no longer on disk.";

type FlowsLoad =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; list: FlowsList };

interface FlowsSource {
  load: FlowsLoad;
  reloading: boolean;
  replace: (list: FlowsList) => void;
  reload: () => void;
}

interface LoadedFlows {
  cwd: string;
  load: FlowsLoad;
  reloadCount: number;
}

function useFlowsLoad(cwd: string | null): FlowsSource {
  const { client } = useApp();
  const [loaded, setLoaded] = useState<LoadedFlows | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (cwd === null) {
      return undefined;
    }
    let active = true;
    const run = async (): Promise<void> => {
      let load: FlowsLoad;
      try {
        load = {
          status: "ready",
          list: await client.request("flows/list", { cwd }),
        };
      } catch (error: unknown) {
        load = { status: "failed", message: errorMessage(error) };
      }
      if (active) {
        setLoaded({ cwd, load, reloadCount });
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [client, cwd, reloadCount]);

  return {
    load: loaded?.cwd === cwd ? loaded.load : { status: "loading" },
    reloading: loaded?.reloadCount !== reloadCount,
    replace: (list) => {
      if (cwd !== null) {
        setLoaded({ cwd, load: { status: "ready", list }, reloadCount });
      }
    },
    reload: () => {
      setReloadCount((count) => count + 1);
    },
  };
}

function FlowErrors({ errors }: { errors: FlowFileError[] }): JSX.Element {
  return (
    <ul className="flow-errors">
      {errors.map((error) => (
        <li key={error.file} className="error">
          {`Could not read ${error.file}: ${error.messages.join("; ")}`}
        </li>
      ))}
    </ul>
  );
}

interface EditSession {
  cwd: string;
  base: FlowBase;
  draft: FlowDraft;
  selection: FlowSelection;
  roundsText: string | null;
  conflict: boolean;
  saveToken: symbol | null;
}

interface FlowEditor {
  session: EditSession | null;
  saving: boolean;
  saveError: string | null;
  setDraft: (draft: FlowDraft) => void;
  setSelection: (selection: FlowSelection) => void;
  setRoundsText: (text: string | null) => void;
  start: (flow: FlowView) => void;
  discard: () => void;
  save: (onSaved: (list: FlowsList) => void) => void;
}

type SetEditSession = Dispatch<SetStateAction<EditSession | null>>;

async function requestSave(
  client: IpcClient,
  started: EditSession,
  token: symbol,
  setStored: SetEditSession,
  onSaved: (list: FlowsList) => void,
): Promise<void> {
  try {
    const saved = await client.request(
      "flows/save",
      saveParamsOf(started.cwd, started.base, started.draft),
    );
    onSaved(saved);
    setStored((current) => (current?.saveToken === token ? null : current));
  } catch (error: unknown) {
    if (
      error instanceof IpcRemoteError &&
      error.code === IpcErrorCode.CONFLICT
    ) {
      setStored((current) =>
        current?.saveToken === token
          ? { ...current, conflict: true, saveToken: null }
          : current,
      );
      return;
    }
    throw error;
  }
}

function useFlowEditor(cwd: string | null): FlowEditor {
  const { client } = useApp();
  const [stored, setStored] = useState<EditSession | null>(null);
  const saving = useAsyncAction();
  if (stored !== null && stored.cwd !== cwd) {
    setStored(null);
  }
  const session = stored?.cwd === cwd ? stored : null;

  const patch = (change: Partial<EditSession>): void => {
    setStored((current) =>
      current === null ? null : { ...current, ...change },
    );
  };

  return {
    session,
    saving: saving.pending,
    saveError: saving.error,
    setDraft: (draft) => {
      patch({ draft });
    },
    setSelection: (selection) => {
      patch({ selection });
    },
    setRoundsText: (roundsText) => {
      patch({ roundsText });
    },
    start: (flow) => {
      if (cwd !== null) {
        setStored({
          cwd,
          base: baseOf(flow),
          draft: draftOf(flow),
          selection: null,
          roundsText: null,
          conflict: false,
          saveToken: null,
        });
      }
    },
    discard: () => {
      setStored(null);
      saving.setError(null);
    },
    save: (onSaved) => {
      if (session === null) {
        return;
      }
      const token = Symbol("flow-save");
      const started = { ...session, conflict: false, saveToken: token };
      setStored(started);
      void saving.run(() =>
        requestSave(client, started, token, setStored, onSaved),
      );
    },
  };
}

function FlowToolbar({
  editing,
  saving,
  canEdit,
  canSave,
  onEdit,
  onSave,
  onDiscard,
}: {
  editing: boolean;
  saving: boolean;
  canEdit: boolean;
  canSave: boolean;
  onEdit: () => void;
  onSave: () => void;
  onDiscard: () => void;
}): JSX.Element {
  if (!editing) {
    return (
      <button
        type="button"
        className="btn"
        disabled={!canEdit}
        onClick={onEdit}
      >
        Edit
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn pri"
        disabled={!canSave}
        onClick={onSave}
      >
        Save
      </button>
      <button
        type="button"
        className="btn"
        disabled={saving}
        onClick={onDiscard}
      >
        Discard
      </button>
    </>
  );
}

function FlowEditFeedback({
  errors,
  conflict,
  saveError,
  onReload,
}: {
  errors: readonly string[];
  conflict: boolean;
  saveError: string | null;
  onReload: () => void;
}): JSX.Element {
  return (
    <>
      <ul className="flow-errors">
        {errors.map((message) => (
          <li key={message} className="error">
            {message}
          </li>
        ))}
      </ul>
      {conflict && (
        <p className="error" role="alert">
          {FLOW_CONFLICT_MESSAGE}{" "}
          <button type="button" className="btn" onClick={onReload}>
            Reload
          </button>
        </p>
      )}
      {saveError !== null && <p className="error">{saveError}</p>}
    </>
  );
}

function FlowPicker({
  list,
  session,
  editor,
  reloading,
  onOpenSession,
  onSaved,
  onReload,
}: {
  list: FlowsList;
  session: SessionView | null;
  editor: FlowEditor;
  reloading: boolean;
  onOpenSession: () => void;
  onSaved: (list: FlowsList) => void;
  onReload: () => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    session?.flowRef?.flowId ?? null,
  );
  const editedId = editor.session?.base.flowId ?? selectedId;
  const found = list.flows.find((candidate) => candidate.id === editedId);
  const flow = editor.session === null ? (found ?? list.flows[0]) : found;
  const draft = editor.session?.draft ?? null;
  const missing = editor.session !== null && flow === undefined;
  const errors = draft === null ? [] : draftErrors(draft, list.agents);
  const canSave =
    draft !== null &&
    flow !== undefined &&
    !editor.saving &&
    errors.length === 0 &&
    editor.session?.roundsText === null &&
    isDraftChanged(draft, flow);
  const reload = (): void => {
    editor.discard();
    onReload();
  };

  return (
    <>
      <div className="flow-toolbar">
        {list.flows.length > 1 && !missing && (
          <select
            aria-label="Flow"
            className="flow-picker"
            value={flow?.id}
            disabled={draft !== null}
            onChange={(event) => {
              setSelectedId(event.target.value);
            }}
          >
            {list.flows.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        )}
        {(flow !== undefined || missing) && (
          <FlowToolbar
            editing={draft !== null}
            saving={editor.saving}
            canEdit={
              flow !== undefined &&
              !reloading &&
              !list.errors.some((error) => error.file === flow.file)
            }
            canSave={canSave}
            onEdit={() => {
              if (flow !== undefined) {
                editor.start(flow);
              }
            }}
            onSave={() => {
              editor.save(onSaved);
            }}
            onDiscard={editor.discard}
          />
        )}
      </div>
      {missing ? (
        <p className="error">{FLOW_MISSING_MESSAGE}</p>
      ) : flow === undefined ? (
        <p className="empty">No flows found in this folder.</p>
      ) : editor.session === null ? (
        <FlowGraph
          flow={flow}
          agents={list.agents}
          session={session}
          onOpenSession={onOpenSession}
        />
      ) : (
        <div className="flow-editor">
          <FlowGraph
            editable
            flow={flow}
            agents={list.agents}
            session={session}
            locked={editor.saving}
            draft={editor.session.draft}
            selection={editor.session.selection}
            onDraftChange={editor.setDraft}
            onSelectionChange={editor.setSelection}
            onOpenSession={onOpenSession}
          />
          <FlowInspector
            draft={editor.session.draft}
            agents={list.agents}
            selection={editor.session.selection}
            roundsText={editor.session.roundsText}
            disabled={editor.saving}
            onDraftChange={editor.setDraft}
            onSelectionChange={editor.setSelection}
            onRoundsTextChange={editor.setRoundsText}
          />
        </div>
      )}
      {editor.session !== null && (
        <FlowEditFeedback
          errors={errors}
          conflict={editor.session.conflict}
          saveError={editor.saveError}
          onReload={reload}
        />
      )}
      <FlowErrors errors={list.errors} />
    </>
  );
}

function FlowTabBody({
  session,
  source,
  editor,
  onOpenSession,
}: {
  session: SessionView | null;
  source: FlowsSource;
  editor: FlowEditor;
  onOpenSession: () => void;
}): JSX.Element {
  const { load } = source;
  if (session === null) {
    return <p className="empty">Start a session to see its flows.</p>;
  }
  switch (load.status) {
    case "loading":
      return <p className="empty">Loading flows…</p>;
    case "failed":
      return <p className="error">{load.message}</p>;
    case "ready":
      return (
        <FlowPicker
          list={load.list}
          session={session}
          editor={editor}
          reloading={source.reloading}
          onOpenSession={onOpenSession}
          onSaved={source.replace}
          onReload={source.reload}
        />
      );
  }
}

function FlowTab({
  editor,
  onOpenSession,
}: {
  editor: FlowEditor;
  onOpenSession: () => void;
}): JSX.Element {
  const { state } = useApp();
  const session = state.snapshot?.session ?? null;
  const source = useFlowsLoad(session?.cwd ?? null);

  return (
    <section className="glass panel flow-tab" aria-label="Flow">
      <h2 className="sec">Flow</h2>
      <FlowTabBody
        session={session}
        source={source}
        editor={editor}
        onOpenSession={onOpenSession}
      />
    </section>
  );
}

function backendText(status: BackendStatus): string {
  switch (status.state) {
    case "connecting":
      return "Connecting…";
    case "ready":
      return import.meta.env.DEV ? `PID ${status.pid.toString()}` : "Connected";
    case "unavailable":
      return "Disconnected";
  }
}

export function App(): JSX.Element {
  const { client, state } = useApp();
  const [measuredFps, setMeasuredFps] = useState<number | undefined>(undefined);
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [centreTab, setCentreTab] = useState<CentreTab>("session");
  const flowEditor = useFlowEditor(state.snapshot?.session?.cwd ?? null);
  const backend = useBackendStatus(client);
  const dock = useTerminalDock();
  const [columnRef, columnSize] = useElementSize<HTMLDivElement>();
  const effectSetting =
    state.snapshot?.settings.effectLevel ?? EffectSetting.auto;

  const level = chooseEffectLevel({
    gpuAccelerated: window.codeweave.gpuAccelerated,
    measuredFps,
    manual: effectSetting === EffectSetting.auto ? undefined : effectSetting,
  });

  useEffect(() => {
    document.documentElement.dataset.fx = level;
  }, [level]);

  useEffect(() => {
    let active = true;
    void measureFps(FPS_MEASURE_DURATION_MS).then((fps) => {
      if (active) {
        setMeasuredFps(fps);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const closeDialog = (): void => {
    setOpenDialog(null);
  };
  const openSessionTab = (): void => {
    setCentreTab("session");
  };

  return (
    <div className="app">
      <header className="glass app-header">
        <div className="logo">
          <i />
          CODEWEAVE
        </div>
        <UpdateBanner />
        <div className="spacer" />
        <output
          className="pill"
          aria-label="Backend"
          data-pid={backend.state === "ready" ? backend.pid : undefined}
          title={backend.state === "unavailable" ? backend.message : undefined}
        >
          {backendText(backend)}
        </output>
        <button
          type="button"
          className="pill"
          aria-pressed={dock.open}
          title="Toggle terminal (Ctrl+`)"
          onClick={dock.toggle}
        >
          Terminal
        </button>
        <button
          type="button"
          className="pill"
          onClick={() => {
            setOpenDialog("accounts");
          }}
        >
          Accounts
        </button>
        <button
          type="button"
          className="pill"
          onClick={() => {
            setOpenDialog("settings");
          }}
        >
          Settings
        </button>
      </header>
      <Sidebar
        onManageAccounts={() => {
          setOpenDialog("accounts");
        }}
      />
      <div className="centre-column" ref={columnRef}>
        <div role="tablist" aria-label="Views" className="tabs">
          {CENTRE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={centreTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              className="tab"
              onClick={() => {
                setCentreTab(tab.id);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`panel-${centreTab}`}
          aria-labelledby={`tab-${centreTab}`}
          className="tab-panel"
        >
          {centreTab === "session" ? (
            <SessionStream />
          ) : (
            <FlowTab editor={flowEditor} onOpenSession={openSessionTab} />
          )}
        </div>
        {dock.open && (
          <TerminalDock
            level={level}
            columnHeight={columnSize.height}
            onHide={dock.hide}
          />
        )}
      </div>
      <div className="side-column">
        <LimitsPanel />
        <SwitchLog />
      </div>
      {openDialog === "accounts" && <AccountsDialog onClose={closeDialog} />}
      {openDialog === "settings" && <SettingsDialog onClose={closeDialog} />}
    </div>
  );
}
