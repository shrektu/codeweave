import { useState, type JSX } from "react";

import type { ToolCallView } from "../../shared/views";

import { CodeBlock } from "../markdown/CodeBlock";

import { DiffBlock } from "./DiffBlock";

export const OUTPUT_PREVIEW_CHARS = 2000;
export const OUTPUT_PREVIEW_LINES = 12;

const STATUS_LABELS: Record<ToolCallView["status"], string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
};

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
