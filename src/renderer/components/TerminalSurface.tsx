import { useRef, type JSX } from "react";

import type { EffectLevel } from "../effects";
import { useTerminal } from "../terminal/useTerminal";

interface TerminalSurfaceProps {
  cwd: string;
  level: EffectLevel;
}

export function TerminalSurface({
  cwd,
  level,
}: TerminalSurfaceProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const { state, retry } = useTerminal(cwd, hostRef, level);

  return (
    <div className="terminal-body">
      <div
        ref={hostRef}
        className="terminal-host"
        data-renderer={state.kind === "ready" ? state.renderer : undefined}
        hidden={state.kind === "failed"}
      />
      {state.kind === "failed" && (
        <div className="terminal-message">
          <p className="error">{state.message}</p>
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
