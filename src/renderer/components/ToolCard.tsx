import { useState, type JSX } from "react";

import type { ToolCallView } from "../../shared/views";

export const OUTPUT_PREVIEW_CHARS = 2000;

const STATUS_LABELS: Record<ToolCallView["status"], string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
};

export interface ToolCardProps {
  tool: ToolCallView;
}

export function ToolCard({ tool }: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const output = tool.output ?? "";
  const truncated = output.length > OUTPUT_PREVIEW_CHARS;
  const shownOutput =
    truncated && !expanded ? output.slice(0, OUTPUT_PREVIEW_CHARS) : output;

  return (
    <div className="card tool">
      <div className="tool-head">
        <b>{tool.title}</b>
        <span>{tool.kind}</span>
        <span className="tool-status" data-status={tool.status}>
          {STATUS_LABELS[tool.status]}
        </span>
      </div>
      {tool.command !== undefined && tool.command !== tool.title && (
        <pre>{tool.command}</pre>
      )}
      {output !== "" && <pre>{shownOutput}</pre>}
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
