import { useEffect, useState, type JSX } from "react";

import { EffectLevel as EffectSetting } from "../domain/types";

import { AccountsDialog } from "./components/AccountsDialog";
import { LimitsPanel } from "./components/LimitsPanel";
import { SessionStream } from "./components/SessionStream";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SwitchLog } from "./components/SwitchLog";
import {
  FPS_MEASURE_DURATION_MS,
  chooseEffectLevel,
  measureFps,
} from "./effects";
import { useApp } from "./services";
import { useBackendStatus, type BackendStatus } from "./useBackendStatus";

type OpenDialog = "accounts" | "settings" | null;

function backendText(status: BackendStatus): string {
  switch (status.state) {
    case "connecting":
      return "Connecting…";
    case "ready":
      return `PID ${status.pid.toString()}`;
    case "unavailable":
      return "Disconnected";
  }
}

export function App(): JSX.Element {
  const { client, state } = useApp();
  const [measuredFps, setMeasuredFps] = useState<number | undefined>(undefined);
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const backend = useBackendStatus(client);
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
          title={backend.state === "unavailable" ? backend.message : undefined}
        >
          {backendText(backend)}
        </output>
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
      <SessionStream />
      <div className="side-column">
        <LimitsPanel />
        <SwitchLog />
      </div>
      {openDialog === "accounts" && <AccountsDialog onClose={closeDialog} />}
      {openDialog === "settings" && <SettingsDialog onClose={closeDialog} />}
    </div>
  );
}
