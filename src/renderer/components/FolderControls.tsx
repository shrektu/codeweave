import type { JSX } from "react";

import { useRecentFolders } from "../useRecentFolders";

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
