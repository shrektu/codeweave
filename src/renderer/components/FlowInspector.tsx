import { useState, type JSX, type SyntheticEvent } from "react";

import { MAX_FLOW_ROUNDS, MIN_FLOW_ROUNDS } from "../../domain/constants";
import {
  parseTaskClass,
  TASK_CLASS_ORDER,
  type TaskClass,
} from "../../domain/taskClass";
import { EdgeKind, type ProviderId } from "../../domain/types";
import type { AgentView } from "../../shared/views";
import {
  addEdge,
  addNode,
  edgeKey,
  ROUNDS_RANGE_MESSAGE,
  parseEdgeKind,
  parseProviderId,
  removeEdge,
  removeNode,
  setMaxRounds,
  updateEdge,
  updateNode,
  type DraftEdge,
  type DraftNode,
  type DraftResult,
  type FlowDraft,
  type FlowSelection,
} from "../flowDraft";
import { EDGE_LABELS } from "../flowLayout";
import { PROVIDER_IDS, PROVIDER_LABELS } from "../format";

export interface FlowInspectorProps {
  draft: FlowDraft;
  agents: readonly AgentView[];
  selection: FlowSelection;
  roundsText: string | null;
  disabled: boolean;
  onDraftChange: (draft: FlowDraft) => void;
  onSelectionChange: (selection: FlowSelection) => void;
  onRoundsTextChange: (text: string | null) => void;
}

interface EditorProps {
  draft: FlowDraft;
  agents: readonly AgentView[];
  onDraftChange: (draft: FlowDraft) => void;
}

const EDGE_KINDS = Object.values(EdgeKind);
const DEFAULT_PROVIDER_VALUE = "";
const NO_TASK_CLASS_VALUE = "";
const NO_TASK_CLASS_LABEL = "—";

function Notice({ message }: { message: string | null }): JSX.Element | null {
  return message === null ? null : <p className="error">{message}</p>;
}

function useDraftResult(
  onDraftChange: (draft: FlowDraft) => void,
): [string | null, (result: DraftResult) => boolean] {
  const [notice, setNotice] = useState<string | null>(null);
  const apply = (result: DraftResult): boolean => {
    setNotice(result.ok ? null : result.error);
    if (result.ok) {
      onDraftChange(result.draft);
    }
    return result.ok;
  };
  return [notice, apply];
}

function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: readonly AgentView[];
  value: string;
  onChange: (agent: string) => void;
}): JSX.Element {
  return (
    <label className="field">
      Agent
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {!agents.some((agent) => agent.id === value) && (
          <option value={value}>{`${value} (unknown)`}</option>
        )}
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.id}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProviderSelect({
  agents,
  agent,
  value,
  onChange,
}: {
  agents: readonly AgentView[];
  agent: string;
  value: ProviderId | null;
  onChange: (provider: ProviderId | null) => void;
}): JSX.Element {
  const agentProvider = agents.find((item) => item.id === agent)?.provider;
  const defaultLabel =
    agentProvider === undefined
      ? "Agent default"
      : `Agent default (${PROVIDER_LABELS[agentProvider]})`;
  return (
    <label className="field">
      Provider
      <select
        value={value ?? DEFAULT_PROVIDER_VALUE}
        onChange={(event) => {
          onChange(parseProviderId(event.target.value));
        }}
      >
        <option value={DEFAULT_PROVIDER_VALUE}>{defaultLabel}</option>
        {PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {PROVIDER_LABELS[id]}
          </option>
        ))}
      </select>
    </label>
  );
}

function TaskClassSelect({
  value,
  onChange,
}: {
  value: TaskClass | null;
  onChange: (taskClass: TaskClass | null) => void;
}): JSX.Element {
  return (
    <label className="field">
      Task class
      <select
        value={value ?? NO_TASK_CLASS_VALUE}
        onChange={(event) => {
          onChange(parseTaskClass(event.target.value));
        }}
      >
        <option value={NO_TASK_CLASS_VALUE}>{NO_TASK_CLASS_LABEL}</option>
        {TASK_CLASS_ORDER.map((taskClass) => (
          <option key={taskClass} value={taskClass}>
            {taskClass}
          </option>
        ))}
      </select>
    </label>
  );
}

function KindSelect({
  value,
  onChange,
}: {
  value: EdgeKind;
  onChange: (kind: EdgeKind) => void;
}): JSX.Element {
  return (
    <label className="field">
      Kind
      <select
        value={value}
        onChange={(event) => {
          onChange(parseEdgeKind(event.target.value) ?? value);
        }}
      >
        {EDGE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {EDGE_LABELS[kind]}
          </option>
        ))}
      </select>
    </label>
  );
}

function GateCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (gate: boolean) => void;
}): JSX.Element {
  return (
    <label className="check-field">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      Gate
    </label>
  );
}

function NodeSelect({
  label,
  ids,
  value,
  onChange,
}: {
  label: string;
  ids: readonly string[];
  value: string;
  onChange: (id: string) => void;
}): JSX.Element {
  return (
    <label className="field">
      {label}
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}

function FlowSettings({
  draft,
  roundsText,
  onDraftChange,
  onRoundsTextChange,
}: Pick<
  FlowInspectorProps,
  "draft" | "roundsText" | "onDraftChange" | "onRoundsTextChange"
>): JSX.Element {
  return (
    <section className="inspector-section" aria-label="Flow settings">
      <label className="field">
        Max rounds
        <input
          type="number"
          min={MIN_FLOW_ROUNDS}
          max={MAX_FLOW_ROUNDS}
          value={roundsText ?? draft.maxRounds}
          onChange={(event) => {
            const result = setMaxRounds(draft, Number(event.target.value));
            if (result.ok) {
              onDraftChange(result.draft);
              onRoundsTextChange(null);
            } else {
              onRoundsTextChange(event.target.value);
            }
          }}
          onBlur={() => {
            onRoundsTextChange(null);
          }}
        />
      </label>
      <Notice message={roundsText === null ? null : ROUNDS_RANGE_MESSAGE} />
    </section>
  );
}

function AddNodeForm({
  draft,
  agents,
  onDraftChange,
}: EditorProps): JSX.Element {
  const [notice, apply] = useDraftResult(onDraftChange);
  const [fields, setFields] = useState<DraftNode>({
    id: "",
    agent: agents[0]?.id ?? "",
    provider: null,
    taskClass: null,
  });
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (apply(addNode(draft, { ...fields, id: fields.id.trim() }))) {
      setFields({ ...fields, id: "" });
    }
  };
  return (
    <form className="inspector-section" aria-label="Add node" onSubmit={submit}>
      <label className="field">
        Node id
        <input
          type="text"
          value={fields.id}
          onChange={(event) => {
            setFields({ ...fields, id: event.target.value });
          }}
        />
      </label>
      <AgentSelect
        agents={agents}
        value={fields.agent}
        onChange={(agent) => {
          setFields({ ...fields, agent });
        }}
      />
      <ProviderSelect
        agents={agents}
        agent={fields.agent}
        value={fields.provider}
        onChange={(provider) => {
          setFields({ ...fields, provider });
        }}
      />
      <button type="submit" className="btn">
        Add node
      </button>
      <Notice message={notice} />
    </form>
  );
}

function AddEdgeForm({ draft, onDraftChange }: EditorProps): JSX.Element {
  const [notice, apply] = useDraftResult(onDraftChange);
  const ids = draft.nodes.map((node) => node.id);
  const [fields, setFields] = useState<DraftEdge>({
    from: "",
    to: "",
    kind: EdgeKind.handsOffTo,
    gate: false,
  });
  const from = ids.includes(fields.from) ? fields.from : (ids[0] ?? "");
  const to = ids.includes(fields.to) ? fields.to : (ids[1] ?? ids[0] ?? "");
  return (
    <form
      className="inspector-section"
      aria-label="Add edge"
      onSubmit={(event) => {
        event.preventDefault();
        apply(addEdge(draft, { ...fields, from, to }));
      }}
    >
      <NodeSelect
        label="From"
        ids={ids}
        value={from}
        onChange={(id) => {
          setFields({ ...fields, from: id });
        }}
      />
      <NodeSelect
        label="To"
        ids={ids}
        value={to}
        onChange={(id) => {
          setFields({ ...fields, to: id });
        }}
      />
      <KindSelect
        value={fields.kind}
        onChange={(kind) => {
          setFields({ ...fields, kind });
        }}
      />
      <GateCheckbox
        checked={fields.gate}
        onChange={(gate) => {
          setFields({ ...fields, gate });
        }}
      />
      <button type="submit" className="btn">
        Add edge
      </button>
      <Notice message={notice} />
    </form>
  );
}

function NodeEditor({
  node,
  draft,
  agents,
  onDraftChange,
  onSelectionChange,
}: EditorProps & {
  node: DraftNode;
  onSelectionChange: (selection: FlowSelection) => void;
}): JSX.Element {
  return (
    <section className="inspector-section" aria-label={`Node ${node.id}`}>
      <AgentSelect
        agents={agents}
        value={node.agent}
        onChange={(agent) => {
          onDraftChange(updateNode(draft, node.id, { agent }));
        }}
      />
      <ProviderSelect
        agents={agents}
        agent={node.agent}
        value={node.provider}
        onChange={(provider) => {
          onDraftChange(updateNode(draft, node.id, { provider }));
        }}
      />
      <TaskClassSelect
        value={node.taskClass}
        onChange={(taskClass) => {
          onDraftChange(updateNode(draft, node.id, { taskClass }));
        }}
      />
      <button
        type="button"
        className="btn"
        onClick={() => {
          onDraftChange(removeNode(draft, node.id));
          onSelectionChange(null);
        }}
      >
        Remove node
      </button>
    </section>
  );
}

function EdgeEditor({
  edge,
  draft,
  onDraftChange,
  onSelectionChange,
}: Pick<EditorProps, "draft" | "onDraftChange"> & {
  edge: DraftEdge;
  onSelectionChange: (selection: FlowSelection) => void;
}): JSX.Element {
  const [notice, apply] = useDraftResult(onDraftChange);
  const key = edgeKey(edge);
  return (
    <section className="inspector-section" aria-label={`Edge ${key}`}>
      <KindSelect
        value={edge.kind}
        onChange={(kind) => {
          if (apply(updateEdge(draft, key, { kind }))) {
            onSelectionChange({
              kind: "edge",
              key: edgeKey({ ...edge, kind }),
            });
          }
        }}
      />
      <GateCheckbox
        checked={edge.gate}
        onChange={(gate) => {
          apply(updateEdge(draft, key, { gate }));
        }}
      />
      <button
        type="button"
        className="btn"
        onClick={() => {
          onDraftChange(removeEdge(draft, key));
          onSelectionChange(null);
        }}
      >
        Remove edge
      </button>
      <Notice message={notice} />
    </section>
  );
}

function SelectionEditor(props: FlowInspectorProps): JSX.Element | null {
  const { draft, selection } = props;
  const node =
    selection?.kind === "node"
      ? draft.nodes.find((item) => item.id === selection.id)
      : undefined;
  const edge =
    selection?.kind === "edge"
      ? draft.edges.find((item) => edgeKey(item) === selection.key)
      : undefined;
  if (node !== undefined) {
    return <NodeEditor {...props} node={node} />;
  }
  return edge === undefined ? null : <EdgeEditor {...props} edge={edge} />;
}

function hasSelectionTarget({ draft, selection }: FlowInspectorProps): boolean {
  if (selection?.kind === "node") {
    return draft.nodes.some((node) => node.id === selection.id);
  }
  return (
    selection?.kind === "edge" &&
    draft.edges.some((edge) => edgeKey(edge) === selection.key)
  );
}

export function FlowInspector(props: FlowInspectorProps): JSX.Element {
  return (
    <aside className="flow-inspector" aria-label="Inspector">
      <fieldset className="flow-inspector-fields" disabled={props.disabled}>
        {hasSelectionTarget(props) ? (
          <SelectionEditor {...props} />
        ) : (
          <>
            <FlowSettings {...props} />
            <AddNodeForm {...props} />
            <AddEdgeForm {...props} />
          </>
        )}
      </fieldset>
    </aside>
  );
}
