import { useState, type JSX } from "react";

import { TerminalStatus } from "../../domain/types";
import type { TerminalView } from "../../shared/views";
import type { EffectLevel } from "../effects";
import { shownSessionOf } from "../format";
import { useApp } from "../services";
import { requestPendingClose } from "../terminal/attachments";
import { clampDockHeight, DOCK_DEFAULT_HEIGHT_PX } from "../terminal/dockSize";
import { DEFAULT_TERMINAL_SIZE } from "../terminal/size";
import { useAsyncAction } from "../useAsyncAction";

import { DockSplitter } from "./DockSplitter";
import { TerminalSurface } from "./TerminalSurface";

const PATH_SEPARATOR = /[\\/]/;

function shellName(shell: string): string {
  return shell.split(PATH_SEPARATOR).findLast((part) => part !== "") ?? shell;
}

function dockLabel(
  terminal: TerminalView | null,
  folder: string | null,
): string {
  return terminal === null
    ? (folder ?? "")
    : `${shellName(terminal.shell)} · ${terminal.cwd}`;
}

function PickFolderBody({
  onPicked,
}: {
  onPicked: (folder: string) => void;
}): JSX.Element {
  const pick = useAsyncAction();
  return (
    <div className="terminal-message">
      <button
        type="button"
        className="btn pri"
        disabled={pick.pending}
        onClick={() => {
          void pick.run(async () => {
            const folder = await window.codeweave.pickFolder();
            if (folder !== null) {
              onPicked(folder);
            }
          });
        }}
      >
        Open in folder…
      </button>
      {pick.error !== null && <p className="error">{pick.error}</p>}
    </div>
  );
}

function ExitedBody({ terminal }: { terminal: TerminalView }): JSX.Element {
  const { client } = useApp();
  const restart = useAsyncAction();
  const text =
    terminal.exitCode === null
      ? "Shell exited"
      : `Shell exited with code ${terminal.exitCode.toString()}`;
  return (
    <div className="terminal-message">
      <p>{text}</p>
      <button
        type="button"
        className="btn pri"
        disabled={restart.pending}
        onClick={() => {
          void restart.run(() =>
            client.request("terminal/open", {
              cwd: terminal.cwd,
              ...DEFAULT_TERMINAL_SIZE,
            }),
          );
        }}
      >
        Restart
      </button>
      {restart.error !== null && <p className="error">{restart.error}</p>}
    </div>
  );
}

interface DockBodyProps {
  terminal: TerminalView | null;
  folder: string | null;
  level: EffectLevel;
  onPicked: (folder: string) => void;
}

function DockBody({
  terminal,
  folder,
  level,
  onPicked,
}: DockBodyProps): JSX.Element {
  if (terminal?.status === TerminalStatus.exited) {
    return <ExitedBody terminal={terminal} />;
  }
  if (folder === null) {
    return <PickFolderBody onPicked={onPicked} />;
  }
  return <TerminalSurface cwd={folder} level={level} />;
}

interface DockHeaderProps {
  terminal: TerminalView | null;
  label: string;
  onHide: () => void;
}

function DockHeader({ terminal, label, onHide }: DockHeaderProps): JSX.Element {
  const { client } = useApp();
  const close = useAsyncAction();
  const closeTerminal = (): void => {
    if (terminal === null) {
      requestPendingClose(client);
    }
    void close
      .run(async () => {
        if (terminal !== null) {
          await client.request("terminal/close", { id: terminal.id });
        }
      })
      .then((closed) => {
        if (closed) {
          onHide();
        }
      });
  };

  return (
    <header className="terminal-header">
      <h2 className="sec">Terminal</h2>
      <span className="terminal-label">{label}</span>
      <div className="spacer" />
      {close.error !== null && <span className="error">{close.error}</span>}
      <button
        type="button"
        className="btn"
        disabled={close.pending}
        onClick={closeTerminal}
      >
        Close
      </button>
      <button type="button" className="btn" onClick={onHide}>
        Hide
      </button>
    </header>
  );
}

interface TerminalDockProps {
  level: EffectLevel;
  columnHeight: number;
  onHide: () => void;
}

export function TerminalDock({
  level,
  columnHeight,
  onHide,
}: TerminalDockProps): JSX.Element {
  const { state } = useApp();
  const [height, setHeight] = useState(DOCK_DEFAULT_HEIGHT_PX);
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  const snapshot = state.snapshot;
  const terminal = snapshot?.terminal ?? null;
  const folder =
    terminal?.status === TerminalStatus.running
      ? terminal.cwd
      : (shownSessionOf(snapshot).session?.cwd ?? pickedFolder);
  const shownHeight = clampDockHeight(height, columnHeight);

  return (
    <section
      className="glass panel terminal-dock"
      aria-label="Terminal"
      style={{ height: shownHeight }}
    >
      <DockSplitter
        height={shownHeight}
        onResize={(next) => {
          setHeight(clampDockHeight(next, columnHeight));
        }}
      />
      <DockHeader
        terminal={terminal}
        label={dockLabel(terminal, folder)}
        onHide={onHide}
      />
      {snapshot !== null && (
        <DockBody
          terminal={terminal}
          folder={folder}
          level={level}
          onPicked={setPickedFolder}
        />
      )}
    </section>
  );
}
