import { useEffect, useState, type JSX } from "react";

import { LimitsPanel } from "./components/LimitsPanel";
import { SessionStream } from "./components/SessionStream";
import { Sidebar } from "./components/Sidebar";
import {
  FPS_MEASURE_DURATION_MS,
  chooseEffectLevel,
  measureFps,
  type EffectLevel,
} from "./effects";
import {
  SAMPLE_ACCOUNTS,
  SAMPLE_LIMITS,
  SAMPLE_MESSAGES,
  SAMPLE_TOOL_CARD,
} from "./sampleData";
import { useBackendStatus, type BackendStatus } from "./useBackendStatus";

const EFFECT_LABELS: Record<EffectLevel, string> = {
  low: "niskie",
  full: "pełne",
};

function backendText(status: BackendStatus): string {
  switch (status.state) {
    case "connecting":
      return "łączenie…";
    case "ready":
      return `PID ${status.pid.toString()}`;
    case "unavailable":
      return "brak połączenia";
  }
}

export function App(): JSX.Element {
  const [measuredFps, setMeasuredFps] = useState<number | undefined>(undefined);
  const [manual, setManual] = useState<EffectLevel | undefined>(undefined);
  const backend = useBackendStatus();

  const level = chooseEffectLevel({
    gpuAccelerated: window.codeweave.gpuAccelerated,
    measuredFps,
    manual,
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

  const toggleEffects = (): void => {
    setManual(level === "full" ? "low" : "full");
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
        <button type="button" className="pill" onClick={toggleEffects}>
          Efekty: {EFFECT_LABELS[level]}
        </button>
      </header>
      <Sidebar accounts={SAMPLE_ACCOUNTS} />
      <SessionStream messages={SAMPLE_MESSAGES} toolCard={SAMPLE_TOOL_CARD} />
      <LimitsPanel limits={SAMPLE_LIMITS} />
    </div>
  );
}
