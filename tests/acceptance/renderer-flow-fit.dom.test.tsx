import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactFlowProps } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";

import { FlowGraph } from "../../src/renderer/components/FlowGraph";
import { makeAgent, makeFlow } from "../fakes/fakeIpcClient";

const DEFAULT_REACT_FLOW_MIN_ZOOM = 0.5;

const spies = vi.hoisted(() => ({
  fitView: vi.fn<(options?: { minZoom?: number }) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  props: [] as { minZoom?: number | undefined }[],
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => ({ ...actual.useReactFlow(), fitView: spies.fitView }),
    ReactFlow: (props: ReactFlowProps) => {
      spies.props.push({ minZoom: props.minZoom });
      return <actual.ReactFlow {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  spies.fitView.mockClear();
  spies.props.length = 0;
});

it("flow_fit_allows_zoom_below_default_min", async () => {
  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={null}
      onOpenSession={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(spies.fitView).toHaveBeenCalled();
  });
  const fitMinZooms = spies.fitView.mock.calls.map(
    ([options]) => options?.minZoom,
  );
  expect(
    fitMinZooms.every((zoom) => (zoom ?? 1) < DEFAULT_REACT_FLOW_MIN_ZOOM),
  ).toBe(true);
  expect(
    spies.props.every(
      ({ minZoom }) => (minZoom ?? 1) < DEFAULT_REACT_FLOW_MIN_ZOOM,
    ),
  ).toBe(true);
});
