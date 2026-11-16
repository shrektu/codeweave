import { useId, useState, type JSX } from "react";

import type { AgentView, FlowsList } from "../../shared/views";
import {
  agentDraftErrors,
  isAgentDraftChanged,
  type AgentDraft,
} from "../agentDraft";
import { parseProviderId } from "../flowDraft";
import { PROVIDER_IDS, PROVIDER_LABELS } from "../format";
import { PROFILE_OPTIONS } from "../profileOptions";
import type { AgentSession } from "../useAgentEditor";

import { AgentModelField } from "./AgentModelField";
import { Dialog } from "./Dialog";
import { EditFeedback } from "./EditFeedback";

const CONFLICT_MESSAGE =
  "This agent file changed on disk. Reload to edit the latest version.";

export interface AgentFormProps {
  list: FlowsList;
  session: AgentSession;
  view: AgentView | null;
  saving: boolean;
  error: string | null;
  onChange: (draft: AgentDraft) => void;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
  onReload: () => void;
}

interface DraftFieldProps {
  draft: AgentDraft;
  disabled: boolean;
  onChange: (draft: AgentDraft) => void;
}

function usedByReason(view: AgentView | null): string | null {
  const count = view?.usedBy.length ?? 0;
  return count === 0
    ? null
    : `Used by ${count.toString()} ${count === 1 ? "flow" : "flows"}. Remove it from those flows first.`;
}

function TextField({
  label,
  value,
  disabled,
  readOnly = false,
  describedBy,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  readOnly?: boolean;
  describedBy?: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

function ProviderSelect({
  draft,
  disabled,
  onChange,
}: DraftFieldProps): JSX.Element {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Provider</label>
      <select
        id={id}
        value={draft.provider}
        disabled={disabled}
        onChange={(event) => {
          const provider = parseProviderId(event.target.value);
          if (provider !== null) {
            onChange({ ...draft, provider });
          }
        }}
      >
        {PROVIDER_IDS.map((provider) => (
          <option key={provider} value={provider}>
            {PROVIDER_LABELS[provider]}
          </option>
        ))}
      </select>
    </div>
  );
}

function ProfileSelect({
  draft,
  disabled,
  onChange,
}: DraftFieldProps): JSX.Element {
  const id = useId();
  const hintId = useId();
  const profile = PROFILE_OPTIONS.find(
    (option) => option.value === draft.permissionProfile,
  );
  return (
    <div className="field">
      <label htmlFor={id}>Permission profile</label>
      <select
        id={id}
        value={draft.permissionProfile}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => {
          const next = PROFILE_OPTIONS.find(
            (option) => option.value === event.target.value,
          );
          if (next !== undefined) {
            onChange({ ...draft, permissionProfile: next.value });
          }
        }}
      >
        {PROFILE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={hintId} className="agent-hint">
        {profile?.description}
      </p>
    </div>
  );
}

function BodyField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (body: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Instructions</label>
      <textarea
        id={id}
        className="agent-body"
        value={value}
        disabled={disabled}
        rows={12}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

function Fields({
  draft,
  disabled,
  reasonId,
  idLocked,
  onChange,
}: DraftFieldProps & { reasonId: string; idLocked: boolean }): JSX.Element {
  const set = (change: Partial<AgentDraft>): void => {
    onChange({ ...draft, ...change });
  };
  return (
    <>
      <TextField
        label="Id"
        value={draft.id}
        disabled={disabled}
        readOnly={idLocked}
        describedBy={idLocked ? reasonId : undefined}
        onChange={(id) => {
          set({ id });
        }}
      />
      <TextField
        label="Role"
        value={draft.role}
        disabled={disabled}
        onChange={(role) => {
          set({ role });
        }}
      />
      <ProviderSelect draft={draft} disabled={disabled} onChange={onChange} />
      <ProfileSelect draft={draft} disabled={disabled} onChange={onChange} />
      <AgentModelField
        provider={draft.provider}
        value={draft.model}
        disabled={disabled}
        onChange={(model) => {
          set({ model });
        }}
      />
      <TextField
        label="Task class"
        value={draft.taskClass}
        disabled={disabled}
        onChange={(taskClass) => {
          set({ taskClass });
        }}
      />
      <BodyField
        value={draft.body}
        disabled={disabled}
        onChange={(body) => {
          set({ body });
        }}
      />
    </>
  );
}

function UsedBy({
  view,
  reasonId,
}: {
  view: AgentView | null;
  reasonId: string;
}): JSX.Element | null {
  const reason = usedByReason(view);
  if (view === null || reason === null) {
    return null;
  }
  return (
    <section className="inspector-section" aria-label="Used by">
      <h3 className="sec">Used by</h3>
      <ul className="flow-errors">
        {view.usedBy.map((flow) => (
          <li key={flow.file}>{`${flow.title} (${flow.file})`}</li>
        ))}
      </ul>
      <p id={reasonId} className="agent-hint">
        {reason}
      </p>
    </section>
  );
}

function DeleteDialog({
  view,
  list,
  onConfirm,
  onClose,
}: {
  view: AgentView;
  list: FlowsList;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  const others = list.agents.filter(
    (agent) => agent.file === view.file && agent.id !== view.id,
  ).length;
  return (
    <Dialog title={`Delete ${view.id}?`} onClose={onClose}>
      <p>{`This removes the agent "${view.id}" from ${view.file}.`}</p>
      <p className="agent-hint">
        {others === 0
          ? "The file is deleted too."
          : `The file stays because it also holds ${others.toString()} other ${others === 1 ? "agent" : "agents"}.`}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn pri" onClick={onConfirm}>
          Delete agent
        </button>
      </div>
    </Dialog>
  );
}

function DeleteButton({
  list,
  view,
  disabled,
  reasonId,
  onDelete,
}: {
  list: FlowsList;
  view: AgentView;
  disabled: boolean;
  reasonId: string;
  onDelete: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const reason = usedByReason(view);
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={disabled || reason !== null}
        aria-describedby={reason === null ? undefined : reasonId}
        title={reason ?? undefined}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Delete
      </button>
      {confirming && (
        <DeleteDialog
          view={view}
          list={list}
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
          onClose={() => {
            setConfirming(false);
          }}
        />
      )}
    </>
  );
}

function Actions({
  list,
  view,
  saving,
  canSave,
  changed,
  reasonId,
  onSave,
  onDiscard,
  onDelete,
}: {
  list: FlowsList;
  view: AgentView | null;
  saving: boolean;
  canSave: boolean;
  changed: boolean;
  reasonId: string;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="flow-toolbar">
      <button
        type="button"
        className="btn pri"
        disabled={saving || !canSave || !changed}
        onClick={onSave}
      >
        Save
      </button>
      <button
        type="button"
        className="btn"
        disabled={saving || !changed}
        onClick={onDiscard}
      >
        Discard
      </button>
      {view !== null && (
        <DeleteButton
          list={list}
          view={view}
          disabled={saving}
          reasonId={reasonId}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

export function AgentForm({
  list,
  session,
  view,
  saving,
  error,
  onChange,
  onSave,
  onDiscard,
  onDelete,
  onReload,
}: AgentFormProps): JSX.Element {
  const reasonId = useId();
  const { draft } = session;
  const errors = agentDraftErrors(draft, list.agents, view?.id ?? null);

  return (
    <div className="agent-form">
      <Fields
        draft={draft}
        disabled={saving}
        reasonId={reasonId}
        idLocked={usedByReason(view) !== null}
        onChange={onChange}
      />
      <UsedBy view={view} reasonId={reasonId} />
      <Actions
        list={list}
        view={view}
        saving={saving}
        canSave={errors.length === 0}
        changed={isAgentDraftChanged(draft, view)}
        reasonId={reasonId}
        onSave={onSave}
        onDiscard={onDiscard}
        onDelete={onDelete}
      />
      <EditFeedback
        errors={errors}
        conflict={session.conflict}
        conflictMessage={CONFLICT_MESSAGE}
        saveError={error}
        onReload={onReload}
      />
    </div>
  );
}
