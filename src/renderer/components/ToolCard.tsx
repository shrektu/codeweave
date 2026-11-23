import { useState, type JSX } from "react";

import type { DiffOmission, FileChange } from "../../domain/events";
import type { FileDiffView, ToolCallView } from "../../shared/views";

import { CodeBlock } from "../markdown/CodeBlock";

export const OUTPUT_PREVIEW_CHARS = 2000;
export const OUTPUT_PREVIEW_LINES = 12;

const STATUS_LABELS: Record<ToolCallView["status"], string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
};

export const DIFF_PREVIEW_LINES = 40;

const CHANGE_LABELS: Record<FileChange, string> = {
  created: "Created",
  modified: "Modified",
  deleted: "Deleted",
};

const OMISSION_LABELS: Record<DiffOmission, string> = {
  binary: "Diff not shown: binary file.",
  too_large: "Diff not shown: file too large.",
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

function DiffBlock({ diff }: { diff: FileDiffView }): JSX.Element {
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

export interface ToolCardProps {
  tool: ToolCallView;
}

function previewOf(output: string, expanded: boolean): string {
  if (expanded) {
    return output;
  }
  const lines = output.split("\n");
  const byLines = lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n");
  return byLines.length > OUTPUT_PREVIEW_CHARS
    ? byLines.slice(0, OUTPUT_PREVIEW_CHARS)
    : byLines;
}

function ToolOutput({ output }: { output: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shown = previewOf(output, expanded);
  const truncated = shown.length < output.length;
  const lineCount = output.split("\n").length;
  return (
    <>
      <pre className="tool-output">{shown}</pre>
      {(truncated || expanded) && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : `Show all ${lineCount.toString()} lines`}
        </button>
      )}
    </>
  );
}

export function ToolCard({ tool }: ToolCardProps): JSX.Element {
  const output = tool.output ?? "";
  const command =
    tool.command !== undefined && tool.command !== tool.title
      ? tool.command
      : null;

  return (
    <div className="card tool">
      <div className="tool-head">
        <b>{tool.title}</b>
        <span>{tool.kind}</span>
        <span className="tool-status" data-status={tool.status}>
          {STATUS_LABELS[tool.status]}
        </span>
      </div>
      {command !== null &&
        (tool.kind === "execute" ? (
          <CodeBlock language="bash" text={command} pasteable={false} />
        ) : (
          <pre className="tool-output">{command}</pre>
        ))}
      {output !== "" && <ToolOutput key={tool.toolCallId} output={output} />}
      {tool.diffs?.map((diff, index) => (
        <DiffBlock key={`${String(index)}:${diff.path}`} diff={diff} />
      ))}
    </div>
  );
}
