import { validateAgent } from "../domain/agentFile";
import type { AgentDefinition } from "../domain/flows";
import type { TaskClass } from "../domain/taskClass";
import {
  DefinitionSource,
  PermissionProfile,
  ProviderId,
} from "../domain/types";
import type { AgentView } from "../shared/views";

export interface AgentDraft {
  source: DefinitionSource;
  id: string;
  role: string;
  provider: ProviderId;
  model: string;
  permissionProfile: PermissionProfile;
  taskClass: TaskClass | "";
  body: string;
}

const DRAFT_KEYS: readonly (keyof AgentDraft)[] = [
  "source",
  "id",
  "role",
  "provider",
  "model",
  "permissionProfile",
  "taskClass",
  "body",
];

export function emptyAgentDraft(): AgentDraft {
  return {
    source: DefinitionSource.project,
    id: "",
    role: "",
    provider: ProviderId.claude,
    model: "",
    permissionProfile: PermissionProfile.ask,
    taskClass: "",
    body: "",
  };
}

export function agentDraftOf(view: AgentView): AgentDraft {
  return {
    source: view.source,
    id: view.id,
    role: view.role,
    provider: view.provider,
    model: view.model ?? "",
    permissionProfile: view.permissionProfile,
    taskClass: view.taskClass ?? "",
    body: view.body,
  };
}

export function toAgentDefinition(draft: AgentDraft): AgentDefinition {
  const model = draft.model.trim();
  const { taskClass } = draft;
  return {
    id: draft.id,
    role: draft.role,
    provider: draft.provider,
    permissionProfile: draft.permissionProfile,
    ...(model === "" ? {} : { model }),
    ...(taskClass === "" ? {} : { taskClass }),
  };
}

export function agentDraftErrors(
  draft: AgentDraft,
  agents: readonly AgentView[],
  originalId: string | null,
): string[] {
  const otherIds = agents
    .filter((agent) => agent.source === draft.source)
    .filter((agent) => agent.id !== originalId)
    .map((agent) => agent.id);
  return validateAgent(toAgentDefinition(draft), draft.body, otherIds);
}

export function isAgentDraftChanged(
  draft: AgentDraft,
  view: AgentView | null,
): boolean {
  const base = view === null ? emptyAgentDraft() : agentDraftOf(view);
  return DRAFT_KEYS.some((key) => draft[key] !== base[key]);
}
