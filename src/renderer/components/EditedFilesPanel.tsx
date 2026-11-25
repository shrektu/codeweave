import { useState, type JSX } from "react";

import type {
  EditView,
  EditedFileView,
  SessionEditsView,
} from "../../shared/views";

import { relativePath } from "../paths";

import { CHANGE_LABELS, DiffBlock } from "./DiffBlock";

const HUNK_PREFIX = "@@";
const ADD_PREFIX = "+";
const DEL_PREFIX = "-";
const LINE_BREAK = "\n";

export interface EditedFilesPanelProps {
  edits: SessionEditsView | null;
  cwd: string | null;
}

interface LineCounts {
  readonly added: number;
  readonly removed: number;
}

function countLines(edits: readonly EditView[]): LineCounts {
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    if (!("patch" in edit.diff) || edit.diff.patch === "") {
      continue;
    }
    for (const line of edit.diff.patch.split(LINE_BREAK)) {
      if (line.startsWith(HUNK_PREFIX)) {
        continue;
      }
      if (line.startsWith(ADD_PREFIX)) {
        added += 1;
      } else if (line.startsWith(DEL_PREFIX)) {
        removed += 1;
      }
    }
  }
  return { added, removed };
}

function FileRow({
  file,
  cwd,
  expanded,
  onToggle,
}: {
  file: EditedFileView;
  cwd: string | null;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const shownPath = relativePath(file.path, cwd);
  const { added, removed } = countLines(file.edits);
  const editLabel =
    file.edits.length === 1 ? "1 edit" : `${String(file.edits.length)} edits`;
  return (
    <li className="edited-file-item">
      <button
        type="button"
        className="edited-file-row"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="edited-file-path" title={file.path}>
          {shownPath}
        </span>
        <span className="edited-file-meta">
          <span>{CHANGE_LABELS[file.change]}</span>
          <span>{editLabel}</span>
          <span className="edited-file-stats">
            {`+${String(added)} \u2212${String(removed)}`}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="edited-file-edits">
          {file.edits.map((edit, index) => (
            <div
              key={`${edit.runId ?? "main"}:${edit.toolCallId}:${String(index)}`}
              className="edited-file-edit"
            >
              <span className="edited-file-agent">{edit.agent}</span>
              <DiffBlock diff={edit.diff} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

export function EditedFilesPanel({
  edits,
  cwd,
}: EditedFilesPanelProps): JSX.Element {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const files = edits?.files ?? [];

  function togglePath(path: string): void {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  return (
    <section className="panel edited-files" aria-label="Edited files">
      <div className="edited-files-head">
        <h2 className="sec">Edited files</h2>
        <span className="edited-files-count">{files.length}</span>
      </div>
      {files.length === 0 ? (
        <p className="empty">No edited files yet.</p>
      ) : (
        <ul className="edited-files-list">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              cwd={cwd}
              expanded={expandedPaths.has(file.path)}
              onToggle={() => {
                togglePath(file.path);
              }}
            />
          ))}
        </ul>
      )}
      <p className="edited-files-note">
        Edits made through shell commands are not tracked.
      </p>
    </section>
  );
}
