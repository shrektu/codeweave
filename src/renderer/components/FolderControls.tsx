import { Folder, FolderOpen } from "lucide-react";
import type { JSX } from "react";

import { useAsyncAction } from "../useAsyncAction";

import { Icon } from "./Icon";

export function PickFolderButton({
  label,
  primary,
  onPick,
}: {
  label: string;
  primary: boolean;
  onPick: (cwd: string) => void;
}): JSX.Element {
  const pick = useAsyncAction();
  return (
    <>
      <button
        type="button"
        className={primary ? "btn pri" : "btn"}
        disabled={pick.pending}
        onClick={() => {
          void pick.run(async () => {
            const cwd = await window.codeweave.pickFolder();
            if (cwd !== null) {
              onPick(cwd);
            }
          });
        }}
      >
        <Icon icon={FolderOpen} />
        {label}
      </button>
      {pick.error !== null && <p className="error">{pick.error}</p>}
    </>
  );
}

export function FolderPrompt({
  subject,
  onPick,
}: {
  subject: string;
  onPick: (cwd: string) => void;
}): JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <Icon icon={Folder} />
      </span>
      <p className="empty-title">No folder selected</p>
      <p className="empty">{`Choose a project folder to see its ${subject}.`}</p>
      <PickFolderButton label="Choose folder…" primary onPick={onPick} />
    </div>
  );
}
