import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { JSX } from "react";

import type { FlowLayoutEdge, FlowPoint } from "../flowLayout";

function pathOf(points: readonly FlowPoint[]): string {
  return points
    .map(
      ({ x, y }, index) =>
        `${index === 0 ? "M" : "L"}${x.toString()} ${y.toString()}`,
    )
    .join(" ");
}

export function FlowEdge({
  id,
  data,
  markerEnd,
}: EdgeProps<FlowLayoutEdge>): JSX.Element | null {
  if (data === undefined) {
    return null;
  }
  const { points, label, kind } = data;
  return (
    <>
      <BaseEdge
        id={id}
        path={pathOf(points)}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className="flow-edge"
        data-kind={kind}
      />
      <EdgeLabelRenderer>
        <div
          className="flow-edge-label nodrag nopan"
          data-kind={kind}
          style={{
            width: label.width,
            height: label.height,
            transform: `translate(${label.x.toString()}px, ${label.y.toString()}px)`,
          }}
        >
          {label.text}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
