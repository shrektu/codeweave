import { useEffect, useId, useState, type JSX } from "react";

import { ProviderId } from "../../domain/types";
import type { ModelCatalog } from "../../shared/views";
import { errorMessage } from "../errorMessage";
import { hasUnknownApiProvider } from "../routingText";
import { useApp } from "../services";

const UNKNOWN_MODEL_WARNING = "This model is not in the OpenCode catalog.";
const UNKNOWN_PROVIDER_WARNING =
  "The part before the first / is not a known API provider.";

const PROVIDER_MODEL_HELP: Readonly<Record<ProviderId, string>> = {
  [ProviderId.claude]:
    "An alias (sonnet, opus, haiku) or a model id that Claude Code lists; sent with every turn.",
  [ProviderId.codex]: "A Codex model id; sent with every turn.",
  [ProviderId.gemini]:
    "A model name as `agy models` shows it, e.g. Gemini 4 Hydrogen (Medium); passed as --model.",
  [ProviderId.opencode]: "<provider>/<model>, e.g. groq/openai/gpt-oss-20b.",
};

const ROUTING_HELP =
  "Leave empty or set auto to let task-class routing pick a model on API-key accounts; subscriptions then use the CLI default.";

function useModelCatalog(enabled: boolean): ModelCatalog | null {
  const { client } = useApp();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const missing = catalog === null;

  useEffect(() => {
    if (!enabled || !missing) {
      return undefined;
    }
    let active = true;
    client
      .request("models/catalog", {})
      .then((result) => {
        if (active) {
          setCatalog(result);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setCatalog({ models: [], error: errorMessage(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [client, enabled, missing]);

  return catalog;
}

function CatalogNote({
  catalog,
  model,
  suggestions,
}: {
  catalog: ModelCatalog | null;
  model: string;
  suggestions: readonly string[];
}): JSX.Element | null {
  if (catalog === null) {
    return null;
  }
  if (catalog.error !== null) {
    return (
      <p className="agent-hint">{`Model suggestions are unavailable: ${catalog.error}`}</p>
    );
  }
  const trimmed = model.trim();
  return trimmed !== "" && !suggestions.includes(trimmed) ? (
    <p className="warning">{UNKNOWN_MODEL_WARNING}</p>
  ) : null;
}

export function AgentModelField({
  provider,
  value,
  disabled,
  onChange,
}: {
  provider: ProviderId;
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}): JSX.Element {
  const inputId = useId();
  const listId = useId();
  const isOpencode = provider === ProviderId.opencode;
  const catalog = useModelCatalog(isOpencode);
  const suggestions = (catalog?.models ?? []).map(
    (model) => `${model.providerId}/${model.modelId}`,
  );

  return (
    <div className="field">
      <label htmlFor={inputId}>Model</label>
      <input
        id={inputId}
        type="text"
        value={value}
        disabled={disabled}
        list={isOpencode ? listId : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {isOpencode && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
      <p className="agent-hint">{`${PROVIDER_MODEL_HELP[provider]} ${ROUTING_HELP}`}</p>
      {isOpencode && hasUnknownApiProvider(value) && (
        <p className="warning">{UNKNOWN_PROVIDER_WARNING}</p>
      )}
      {isOpencode && (
        <CatalogNote
          catalog={catalog}
          model={value}
          suggestions={suggestions}
        />
      )}
    </div>
  );
}
