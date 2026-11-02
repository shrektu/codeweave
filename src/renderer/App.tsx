import { useEffect, useState, type JSX } from "react";

import { EffectLevel as EffectSetting } from "../domain/types";
import type { FlowFileError, FlowsList, SessionView } from "../shared/views";

import { AccountsDialog } from "./components/AccountsDialog";
import { FlowGraph } from "./components/FlowGraph";
import { LimitsPanel } from "./components/LimitsPanel";
import { SessionStream } from "./components/SessionStream";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SwitchLog } from "./components/SwitchLog";
import { TerminalDock } from "./components/TerminalDock";
import {
  FPS_MEASURE_DURATION_MS,
  chooseEffectLevel,
  measureFps,
} from "./effects";
import { errorMessage } from "./errorMessage";
import { useApp } from "./services";
import { useTerminalDock } from "./terminal/useTerminalDock";
import { useBackendStatus, type BackendStatus } from "./useBackendStatus";
import { useElementSize } from "./useElementSize";

type OpenDialog = "accounts" | "settings" | null;
type CentreTab = "session" | "flow";

const CENTRE_TABS: readonly { id: CentreTab; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "flow", label: "Flow" },
];

type FlowsLoad =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; list: FlowsList };

function useFlowsLoad(cwd: string | null): FlowsLoad {
  const { client } = useApp();
  const [loaded, setLoaded] = useState<{ cwd: string; load: FlowsLoad } | null>(
    null,
  );

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
        setLoaded({ cwd, load });
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [client, cwd]);

  return loaded?.cwd === cwd ? loaded.load : { status: "loading" };
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

function FlowPicker({
  list,
  session,
  onOpenSession,
}: {
  list: FlowsList;
  session: SessionView | null;
  onOpenSession: () => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    session?.flowRef?.flowId ?? null,
  );
  const flow =
    list.flows.find((candidate) => candidate.id === selectedId) ??
    list.flows[0];

  return (
    <>
      {list.flows.length > 1 && (
        <select
          aria-label="Flow"
          className="flow-picker"
          value={flow?.id}
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
      {flow === undefined ? (
        <p className="empty">No flows found in this folder.</p>
      ) : (
        <FlowGraph
          flow={flow}
          agents={list.agents}
          session={session}
          onOpenSession={onOpenSession}
        />
      )}
      <FlowErrors errors={list.errors} />
    </>
  );
}

function FlowTabBody({
  session,
  load,
  onOpenSession,
}: {
  session: SessionView | null;
  load: FlowsLoad;
  onOpenSession: () => void;
}): JSX.Element {
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
          onOpenSession={onOpenSession}
        />
      );
  }
}

function FlowTab({
  onOpenSession,
}: {
  onOpenSession: () => void;
}): JSX.Element {
  const { state } = useApp();
  const session = state.snapshot?.session ?? null;
  const load = useFlowsLoad(session?.cwd ?? null);

  return (
    <section className="glass panel flow-tab" aria-label="Flow">
      <h2 className="sec">Flow</h2>
      <FlowTabBody
        session={session}
        load={load}
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
            <FlowTab onOpenSession={openSessionTab} />
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
