import { Folder } from "lucide-react";
import type { JSX } from "react";

import { useRecentFolders } from "../useRecentFolders";

import { Icon } from "./Icon";
import { PathField } from "./PathField";

export function PickFolderButton({
  label,
  primary,
  onPick,
}: {
  label: string;
  primary: boolean;
  onPick: (cwd: string) => void;
}): JSX.Element {
  const recent = useRecentFolders();
  return (
    <PathField
      value={null}
      kind="folder"
      label="Project folder"
      chooseLabel={label}
      primary={primary}
      recent={recent}
      onChange={onPick}
    />
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
