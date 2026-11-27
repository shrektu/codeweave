import {
  Pencil,
  Settings,
  SquareTerminal,
  Users,
  Waypoints,
  Workflow,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from "react";

import { isRunOpen } from "../domain/flowState";
import {
  Appearance as AppearanceSetting,
  DefinitionSource,
  EffectLevel as EffectSetting,
  FlowRunOrigin,
} from "../domain/types";
import type {
  FlowRunView,
  FlowsList,
  FlowView,
  SessionView,
  Snapshot,
} from "../shared/views";

import { AccountsDialog } from "./components/AccountsDialog";
import { AgentsTab } from "./components/AgentsTab";
import { EditFeedback } from "./components/EditFeedback";
import { EditedFilesPanel } from "./components/EditedFilesPanel";
import { FlowErrors } from "./components/FlowErrors";
import { FlowGraph } from "./components/FlowGraph";
import { FlowInspector } from "./components/FlowInspector";
import { FlowRunPanel } from "./components/FlowRunPanel";
import { PickFolderButton } from "./components/FolderControls";
import { Icon } from "./components/Icon";
import { LimitsPanel } from "./components/LimitsPanel";
import { OrchestratorTimeline } from "./components/OrchestratorTimeline";
import { SessionStream } from "./components/SessionStream";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SourceBadge } from "./components/SourceBadge";
import { SwitchLog } from "./components/SwitchLog";
import { TerminalDock } from "./components/TerminalDock";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  FPS_MEASURE_DURATION_MS,
  chooseEffectLevel,
  measureFps,
} from "./effects";
import { requestUnlessConflict } from "./conflictRequest";
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
import {
  activeSessionOf,
  anySessionLive,
  DEFINITION_SOURCE_LABELS,
  focusedRunOf,
  isSessionLive,
  latestOpenRunOf,
  latestRunOf,
  shownSessionOf,
} from "./format";
import type { IpcClient } from "./ipc";
import { useApp } from "./services";
import {
  applyTheme,
  readStoredAppearance,
  storeAppearance,
  useResolvedTheme,
} from "./theme";
import { useTerminalDock } from "./terminal/useTerminalDock";
import {
  agentEditorPinsFolder,
  useAgentEditor,
  type AgentEditor,
} from "./useAgentEditor";
import { useAsyncAction } from "./useAsyncAction";
import { useBackendStatus, type BackendStatus } from "./useBackendStatus";
import { useDesktopNotifications } from "./useDesktopNotifications";
import { useElementSize } from "./useElementSize";
import { useFlowsLoad, type FlowsSource } from "./useFlowsLoad";
import { useGpuAccelerated } from "./useGpuAccelerated";

type OpenDialog = "accounts" | "settings" | null;
type CentreTab = "session" | "flow" | "agents";
type SideTab = "limits" | "edits";

const CENTRE_TABS: readonly { id: CentreTab; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "flow", label: "Flow" },
  { id: "agents", label: "Agents" },
];

const FLOW_CONFLICT_MESSAGE =
  "This flow changed on disk. Reload to edit the latest version.";
const FLOW_MISSING_MESSAGE = "This flow is no longer on disk.";
const RUN_LOCK_MESSAGE = "Stop the flow to edit it.";

interface EditSession {
  cwd: string | null;
  base: FlowBase;
  draft: FlowDraft;
  selection: FlowSelection;
  roundsText: string | null;
  conflict: boolean;
  saveToken: symbol | null;
}

interface FlowEditor {
  cwd: string | null;
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
  const saved = await requestUnlessConflict(
    () =>
      client.request(
        "flows/save",
        saveParamsOf(started.cwd, started.base, started.draft),
      ),
    () => {
      setStored((current) =>
        current?.saveToken === token
          ? { ...current, conflict: true, saveToken: null }
          : current,
      );
    },
  );
  if (saved === null) {
    return;
  }
  onSaved(saved);
  setStored((current) => (current?.saveToken === token ? null : current));
}

function useFlowEditor(autoCwd: string | null): FlowEditor {
  const { client } = useApp();
  const [session, setStored] = useState<EditSession | null>(null);
  const saving = useAsyncAction();
  const cwd = session !== null ? session.cwd : autoCwd;

  const patch = (change: Partial<EditSession>): void => {
    setStored((current) =>
      current === null ? null : { ...current, ...change },
    );
  };

  return {
    cwd,
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
      setStored({
        cwd,
        base: baseOf(flow),
        draft: draftOf(flow),
        selection: null,
        roundsText: null,
        conflict: false,
        saveToken: null,
      });
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
  editHint,
  canSave,
  onEdit,
  onSave,
  onDiscard,
}: {
  editing: boolean;
  saving: boolean;
  canEdit: boolean;
  editHint: string | undefined;
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
        title={editHint}
        onClick={onEdit}
      >
        <Icon icon={Pencil} />
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
        title={editHint}
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

function FlowPicker({
  cwd,
  task,
  onTaskChange,
  list,
  session,
  sessionLive,
  flowRun,
  flowSessions,
  runFocused,
  editor,
  reloading,
  onOpenSession,
  onSaved,
  onReload,
}: {
  cwd: string | null;
  task: string;
  onTaskChange: (task: string) => void;
  list: FlowsList;
  session: SessionView | null;
  sessionLive: boolean;
  flowRun: FlowRunView | null;
  flowSessions: Snapshot["flowSessions"];
  runFocused: boolean;
  editor: FlowEditor;
  reloading: boolean;
  onOpenSession: () => void;
  onSaved: (list: FlowsList) => void;
  onReload: () => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    (runFocused ? flowRun?.flowId : session?.flowRef?.flowId) ?? null,
  );
  const locked = flowRun !== null && isRunOpen(flowRun.status);
  const editedId =
    editor.session?.base.flowId ?? (locked ? flowRun.flowId : selectedId);
  const found = list.flows.find((candidate) => candidate.id === editedId);
  const fallback =
    editor.session === null && !locked ? list.flows[0] : undefined;
  const flow = found ?? fallback;
  const runOfFlow =
    flow !== undefined && flowRun?.flowId === flow.id ? flowRun : null;
  const shownRun = locked ? flowRun : runOfFlow;
  const draft = editor.session?.draft ?? null;
  const missing = editor.session !== null && flow === undefined;
  const runFlowMissing = locked && flow === undefined;
  const errors = draft === null ? [] : draftErrors(draft, list.agents);
  const canSave =
    draft !== null &&
    flow !== undefined &&
    !locked &&
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
        {list.flows.length > 1 && !missing && !runFlowMissing && (
          <select
            aria-label="Flow"
            className="flow-picker"
            value={flow?.id}
            disabled={draft !== null || locked}
            onChange={(event) => {
              setSelectedId(event.target.value);
            }}
          >
            {list.flows.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.source === DefinitionSource.library
                  ? `${candidate.title} (${DEFINITION_SOURCE_LABELS[candidate.source]})`
                  : candidate.title}
              </option>
            ))}
          </select>
        )}
        {flow !== undefined && <SourceBadge source={flow.source} />}
        {(flow !== undefined || missing) && (
          <FlowToolbar
            editing={draft !== null}
            saving={editor.saving}
            canEdit={
              flow !== undefined &&
              !reloading &&
              !locked &&
              !list.errors.some(
                (error) =>
                  error.file === flow.file && error.source === flow.source,
              )
            }
            editHint={locked ? RUN_LOCK_MESSAGE : undefined}
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
      {(flow !== undefined || shownRun !== null) && (
        <FlowRunPanel
          cwd={cwd}
          task={task}
          onTaskChange={onTaskChange}
          flow={flow}
          run={shownRun}
          sessionLive={sessionLive}
          editing={draft !== null}
        />
      )}
      {missing || runFlowMissing ? (
        <p className="error">{FLOW_MISSING_MESSAGE}</p>
      ) : flow === undefined ? (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            <Icon icon={Workflow} />
          </span>
          <p className="empty-title">No flows yet</p>
          <p className="empty">
            {cwd === null
              ? "No flows found in the library."
              : "No flows found in this folder."}
          </p>
        </div>
      ) : editor.session === null || locked ? (
        <FlowGraph
          flow={flow}
          agents={list.agents}
          session={session}
          run={runOfFlow}
          flowSessions={flowSessions}
          onOpenSession={onOpenSession}
        />
      ) : (
        <div className="flow-editor">
          <FlowGraph
            editable
            flow={flow}
            agents={list.agents}
            session={session}
            flowSessions={flowSessions}
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
        <EditFeedback
          errors={errors}
          conflict={editor.session.conflict}
          conflictMessage={FLOW_CONFLICT_MESSAGE}
          saveError={editor.saveError}
          onReload={reload}
        />
      )}
      <FlowErrors errors={list.errors} />
    </>
  );
}

function FlowTabBody({
  cwd,
  task,
  onTaskChange,
  session,
  sessionLive,
  flowRun,
  flowSessions,
  runFocused,
  source,
  editor,
  onOpenSession,
}: {
  cwd: string | null;
  task: string;
  onTaskChange: (task: string) => void;
  session: SessionView | null;
  sessionLive: boolean;
  flowRun: FlowRunView | null;
  flowSessions: Snapshot["flowSessions"];
  runFocused: boolean;
  source: FlowsSource;
  editor: FlowEditor;
  onOpenSession: () => void;
}): JSX.Element {
  const { load } = source;
  switch (load.status) {
    case "loading":
      return <p className="empty">Loading flows…</p>;
    case "failed":
      return <p className="error">{load.message}</p>;
    case "ready":
      return (
        <FlowPicker
          cwd={cwd}
          task={task}
          onTaskChange={onTaskChange}
          list={load.list}
          session={session}
          sessionLive={sessionLive}
          flowRun={flowRun}
          flowSessions={flowSessions}
          runFocused={runFocused}
          editor={editor}
          reloading={source.reloading}
          onOpenSession={onOpenSession}
          onSaved={source.replace}
          onReload={source.reload}
        />
      );
  }
}

function openRunCwdOf(snapshot: Snapshot | null): string | null {
  const userRuns = (snapshot?.flowRuns ?? []).filter(
    (run) => run.origin === FlowRunOrigin.user,
  );
  return latestOpenRunOf(userRuns)?.cwd ?? null;
}

function explicitSessionCwdOf(session: SessionView | null): string | null {
  return session?.explicitFolder ? session.cwd : null;
}

function liveSessionCwdOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
): string | null {
  const { session } = shownSessionOf(snapshot, activeSessionId);
  return isSessionLive(session) ? explicitSessionCwdOf(session) : null;
}

function flowCwdOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
  picked: string | null,
): string | null {
  return (
    openRunCwdOf(snapshot) ??
    liveSessionCwdOf(snapshot, activeSessionId) ??
    picked ??
    explicitSessionCwdOf(shownSessionOf(snapshot, activeSessionId).session)
  );
}

function pinnedCwdOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
): string | null {
  return openRunCwdOf(snapshot) ?? liveSessionCwdOf(snapshot, activeSessionId);
}

function isFolderPinned(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
  flowEditor: FlowEditor,
  agentEditor: AgentEditor,
): boolean {
  return (
    pinnedCwdOf(snapshot, activeSessionId) !== null ||
    flowEditor.session !== null ||
    agentEditorPinsFolder(agentEditor.session, agentEditor.saving)
  );
}

function FlowTab({
  cwd,
  editor,
  folderPinned,
  onOpenSession,
  onPickFolder,
}: {
  cwd: string | null;
  editor: FlowEditor;
  folderPinned: boolean;
  onOpenSession: () => void;
  onPickFolder: (cwd: string) => void;
}): JSX.Element {
  const { state } = useApp();
  const source = useFlowsLoad(cwd);
  const [task, setTask] = useState("");
  const { session } = shownSessionOf(state.snapshot, state.activeSessionId);
  const focusedRun = focusedRunOf(
    state.snapshot,
    state.activeSessionId,
    state.focusedRunId,
  );
  const flowRun =
    focusedRun ??
    (cwd === null ? null : latestRunOf(state.snapshot?.flowRuns ?? [], cwd));

  return (
    <section className="glass panel flow-tab" aria-label="Flow">
      <h2 className="sec">Flow</h2>
      {!folderPinned && (
        <PickFolderButton
          label={cwd === null ? "Choose folder…" : "Change folder…"}
          primary={false}
          onPick={onPickFolder}
        />
      )}
      <FlowTabBody
        cwd={cwd}
        task={task}
        onTaskChange={setTask}
        session={session?.cwd === cwd ? session : null}
        sessionLive={anySessionLive(state.snapshot)}
        flowRun={flowRun}
        flowSessions={state.snapshot?.flowSessions ?? []}
        runFocused={focusedRun !== null}
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
  const [sideTab, setSideTab] = useState<SideTab>("limits");
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  const pinnedCwd = pinnedCwdOf(state.snapshot, state.activeSessionId);
  if (pinnedCwd !== null && pinnedCwd !== pickedFolder) {
    setPickedFolder(pinnedCwd);
  }
  const folderCwd = flowCwdOf(
    state.snapshot,
    state.activeSessionId,
    pickedFolder,
  );
  const flowEditor = useFlowEditor(folderCwd);
  const agentEditor = useAgentEditor(folderCwd);
  const folderPinned = isFolderPinned(
    state.snapshot,
    state.activeSessionId,
    flowEditor,
    agentEditor,
  );
  const pickFolder = (cwd: string): void => {
    agentEditor.close();
    setPickedFolder(cwd);
  };
  const backend = useBackendStatus(client);
  const dock = useTerminalDock();
  const gpuAccelerated = useGpuAccelerated();
  const [columnRef, columnSize] = useElementSize<HTMLDivElement>();
  const effectSetting =
    state.snapshot?.settings.effectLevel ?? EffectSetting.auto;

  const level = chooseEffectLevel({
    gpuAccelerated,
    measuredFps,
    manual: effectSetting === EffectSetting.auto ? undefined : effectSetting,
  });

  useEffect(() => {
    document.documentElement.dataset.fx = level;
  }, [level]);

  const savedAppearance = state.snapshot?.settings.appearance;
  const appearance =
    savedAppearance ?? readStoredAppearance() ?? AppearanceSetting.system;
  const theme = useResolvedTheme(appearance);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (savedAppearance === undefined) {
      return;
    }
    storeAppearance(savedAppearance);
    void window.codeweave.setThemeSource(savedAppearance);
  }, [savedAppearance]);

  useEffect(() => {
    document.documentElement.dataset.platform = window.codeweave.platform;
  }, []);

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
  const openFlowTab = (): void => {
    setCentreTab("flow");
  };
  useDesktopNotifications({
    onOpenSession: openSessionTab,
    onOpenFlow: openFlowTab,
  });
  const activeSession = activeSessionOf(state.snapshot, state.activeSessionId);
  const orchestrating = activeSession?.orchestrate === true;
  const sessionId = activeSession?.id ?? null;
  const sessionEdits =
    sessionId === null
      ? null
      : (state.snapshot?.editedFiles.find(
          (entry) => entry.sessionId === sessionId,
        ) ?? null);
  const editedFileCount = sessionEdits?.files.length ?? 0;

  return (
    <div className="app">
      <header className="glass app-header">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true">
            <Icon icon={Waypoints} />
          </span>
          Codeweave
        </div>
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
        <div className="spacer" />
        <output
          className="backend-status"
          data-state={backend.state}
          aria-label="Backend"
          data-pid={backend.state === "ready" ? backend.pid : undefined}
          title={backend.state === "unavailable" ? backend.message : undefined}
        >
          <span className="status-dot" aria-hidden="true" />
          {backendText(backend)}
        </output>
        <button
          type="button"
          className="btn plain toolbar-btn"
          aria-pressed={dock.open}
          title="Toggle terminal (Ctrl+`)"
          onClick={dock.toggle}
        >
          <Icon icon={SquareTerminal} />
          <span className="toolbar-label">Terminal</span>
        </button>
        <button
          type="button"
          className="btn plain toolbar-btn"
          title="Accounts"
          onClick={() => {
            setOpenDialog("accounts");
          }}
        >
          <Icon icon={Users} />
          <span className="toolbar-label">Accounts</span>
        </button>
        <button
          type="button"
          className="btn plain toolbar-btn"
          title="Settings"
          onClick={() => {
            setOpenDialog("settings");
          }}
        >
          <Icon icon={Settings} />
          <span className="toolbar-label">Settings</span>
        </button>
      </header>
      <div className="app-notices">
        <UpdateBanner />
      </div>
      <Sidebar
        onManageAccounts={() => {
          setOpenDialog("accounts");
        }}
        onOpenSession={openSessionTab}
      />
      <div className="centre-column" ref={columnRef}>
        <div
          role="tabpanel"
          id={`panel-${centreTab}`}
          aria-labelledby={`tab-${centreTab}`}
          className="tab-panel"
        >
          {centreTab === "session" && orchestrating && (
            <OrchestratorTimeline onShowGraph={openFlowTab} />
          )}
          {centreTab === "session" && <SessionStream />}
          {centreTab === "flow" && (
            <FlowTab
              cwd={flowEditor.cwd}
              editor={flowEditor}
              folderPinned={folderPinned}
              onOpenSession={openSessionTab}
              onPickFolder={pickFolder}
            />
          )}
          {centreTab === "agents" && (
            <AgentsTab
              cwd={agentEditor.cwd}
              editor={agentEditor}
              folderPinned={folderPinned}
              onPickFolder={pickFolder}
            />
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
        <div role="tablist" aria-label="Details" className="tabs">
          <button
            type="button"
            role="tab"
            id="side-tab-limits"
            aria-selected={sideTab === "limits"}
            aria-controls="side-panel-limits"
            className="tab"
            onClick={() => {
              setSideTab("limits");
            }}
          >
            Limits
          </button>
          <button
            type="button"
            role="tab"
            id="side-tab-edits"
            aria-selected={sideTab === "edits"}
            aria-controls="side-panel-edits"
            className="tab"
            onClick={() => {
              setSideTab("edits");
            }}
          >
            {editedFileCount > 0
              ? `Edited files (${String(editedFileCount)})`
              : "Edited files"}
          </button>
        </div>
        {sideTab === "limits" ? (
          <div
            id="side-panel-limits"
            role="tabpanel"
            aria-labelledby="side-tab-limits"
          >
            <LimitsPanel />
            <SwitchLog />
          </div>
        ) : (
          <div
            id="side-panel-edits"
            role="tabpanel"
            aria-labelledby="side-tab-edits"
          >
            <EditedFilesPanel
              edits={sessionEdits}
              cwd={activeSession?.cwd ?? null}
            />
          </div>
        )}
      </div>
      {openDialog === "accounts" && <AccountsDialog onClose={closeDialog} />}
      {openDialog === "settings" && <SettingsDialog onClose={closeDialog} />}
    </div>
  );
}
