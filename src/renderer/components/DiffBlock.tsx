import { useState, type JSX } from "react";

import type { DiffOmission, FileChange } from "../../domain/events";
import type { FileDiffView } from "../../shared/views";

export const DIFF_PREVIEW_LINES = 40;

export const CHANGE_LABELS: Record<FileChange, string> = {
  created: "Created",
  modified: "Modified",
  deleted: "Deleted",
};

export const OMISSION_LABELS: Record<DiffOmission, string> = {
  binary: "Diff not shown: binary file.",
  too_large: "Diff not shown: file too large.",
  not_reported: "Diff not reported by the provider.",
};

const HUNK_PREFIX = "@@";
const ADD_PREFIX = "+";
const DEL_PREFIX = "-";

function lineKind(line: string): "add" | "del" | "hunk" | "ctx" {
  if (line.startsWith(HUNK_PREFIX)) {
    return "hunk";
  }
  if (line.startsWith(ADD_PREFIX)) {
    return "add";
  }
  return line.startsWith(DEL_PREFIX) ? "del" : "ctx";
}

export function DiffBlock({ diff }: { diff: FileDiffView }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const header = (
    <div className="tool-head">
      <b>{diff.path}</b>
      <span>{CHANGE_LABELS[diff.change]}</span>
    </div>
  );
  if ("omitted" in diff) {
    return (
      <div className="diff-file">
        {header}
        <p className="diff-omitted">{OMISSION_LABELS[diff.omitted]}</p>
      </div>
    );
  }
  if (diff.patch === "") {
    return <div className="diff-file">{header}</div>;
  }
  const lines = diff.patch.split("\n");
  const truncated = lines.length > DIFF_PREVIEW_LINES;
  const shown =
    truncated && !expanded ? lines.slice(0, DIFF_PREVIEW_LINES) : lines;
  return (
    <div className="diff-file">
      {header}
      <pre className="diff" aria-label={`Diff of ${diff.path}`}>
        {shown.map((line, index) => (
          <span
            key={`${String(index)}:${line}`}
            className="diff-line"
            data-kind={lineKind(line)}
          >
            {line}
          </span>
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
