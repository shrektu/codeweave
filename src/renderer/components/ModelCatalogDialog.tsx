import { useEffect, useState, type JSX } from "react";

import {
  API_PROVIDERS,
  TRAINING_UNKNOWN,
  type ApiProviderId,
} from "../../domain/apiProviders";
import type { CatalogModel, ModelCatalog } from "../../shared/views";
import { errorMessage } from "../errorMessage";
import { API_PROVIDER_IDS, parseApiProvider } from "../format";
import { useApp } from "../services";

import { Dialog } from "./Dialog";

export interface ModelCatalogDialogProps {
  provider: ApiProviderId | null;
  onPick: (model: CatalogModel) => void;
  onClose: () => void;
}

interface CatalogFilters {
  query: string;
  provider: ApiProviderId | null;
  freeOnly: boolean;
  noTraining: boolean;
}

const NO_VALUE = "—";
const ALL_PROVIDERS = "";

function matches(model: CatalogModel, filters: CatalogFilters): boolean {
  const query = filters.query.trim().toLowerCase();
  return (
    (filters.provider === null || model.providerId === filters.provider) &&
    (!filters.freeOnly || model.free) &&
    (!filters.noTraining || model.trainsOnData === false) &&
    (query === "" ||
      model.name.toLowerCase().includes(query) ||
      model.modelId.toLowerCase().includes(query))
  );
}

function formatCost(cost: number | null): string {
  return cost === null ? NO_VALUE : `$${cost.toString()}`;
}

function formatContext(tokens: number | null): string {
  return tokens === null ? NO_VALUE : tokens.toLocaleString("en-US");
}

function useCatalog(): ModelCatalog | null {
  const { client } = useApp();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);

  useEffect(() => {
    let current = true;
    void client
      .request("models/catalog", {})
      .then((result) => {
        if (current) {
          setCatalog(result);
        }
      })
      .catch((caught: unknown) => {
        if (current) {
          setCatalog({ models: [], error: errorMessage(caught) });
        }
      });
    return (): void => {
      current = false;
    };
  }, [client]);

  return catalog;
}

function TrainingBadge({ model }: { model: CatalogModel }): JSX.Element | null {
  if (model.trainsOnData === TRAINING_UNKNOWN) {
    return <span className="badge">Training unknown</span>;
  }
  return model.trainsOnData ? (
    <span className="badge warn">Trains on data</span>
  ) : null;
}

function CatalogRow({
  model,
  onUse,
}: {
  model: CatalogModel;
  onUse: () => void;
}): JSX.Element {
  return (
    <li className="catalog-row">
      <div className="catalog-main">
        <b>{model.name}</b>
        <code>{model.modelId}</code>
        <small>{API_PROVIDERS[model.providerId].label}</small>
        <button
          type="button"
          className="btn"
          aria-label={`Use ${model.modelId}`}
          onClick={onUse}
        >
          Use
        </button>
      </div>
      <div className="catalog-meta">
        <span>{`Context ${formatContext(model.contextWindow)}`}</span>
        <span>{`In ${formatCost(model.costIn)}`}</span>
        <span>{`Out ${formatCost(model.costOut)}`}</span>
        {model.free && <span className="badge">Free</span>}
        <TrainingBadge model={model} />
      </div>
    </li>
  );
}

interface FiltersBarProps {
  filters: CatalogFilters;
  onChange: (filters: CatalogFilters) => void;
}

function FiltersBar({ filters, onChange }: FiltersBarProps): JSX.Element {
  return (
    <div className="catalog-filters">
      <label htmlFor="catalog-search">Search models</label>
      <input
        id="catalog-search"
        type="text"
        value={filters.query}
        onChange={(event) => {
          onChange({ ...filters, query: event.target.value });
        }}
      />
      <label htmlFor="catalog-provider">Provider</label>
      <select
        id="catalog-provider"
        value={filters.provider ?? ALL_PROVIDERS}
        onChange={(event) => {
          onChange({
            ...filters,
            provider: parseApiProvider(event.target.value),
          });
        }}
      >
        <option value={ALL_PROVIDERS}>All providers</option>
        {API_PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {API_PROVIDERS[id].label}
          </option>
        ))}
      </select>
      <div className="check-field">
        <input
          id="catalog-free"
          type="checkbox"
          checked={filters.freeOnly}
          onChange={(event) => {
            onChange({ ...filters, freeOnly: event.target.checked });
          }}
        />
        <label htmlFor="catalog-free">Free only</label>
      </div>
      <div className="check-field">
        <input
          id="catalog-no-training"
          type="checkbox"
          checked={filters.noTraining}
          onChange={(event) => {
            onChange({ ...filters, noTraining: event.target.checked });
          }}
        />
        <label htmlFor="catalog-no-training">No training on data</label>
      </div>
    </div>
  );
}

function CatalogList({
  catalog,
  filters,
  onUse,
}: {
  catalog: ModelCatalog | null;
  filters: CatalogFilters;
  onUse: (model: CatalogModel) => void;
}): JSX.Element {
  if (catalog === null) {
    return <p>Loading models…</p>;
  }
  if (catalog.error !== null) {
    return <p className="error">{catalog.error}</p>;
  }
  const models = catalog.models.filter((model) => matches(model, filters));
  if (models.length === 0) {
    return <p>No models match</p>;
  }
  return (
    <>
      <ul className="catalog-list">
        {models.map((model) => (
          <CatalogRow
            key={`${model.providerId}/${model.modelId}`}
            model={model}
            onUse={() => {
              onUse(model);
            }}
          />
        ))}
      </ul>
      <small>Prices are per 1M tokens.</small>
    </>
  );
}

export function ModelCatalogDialog({
  provider,
  onPick,
  onClose,
}: ModelCatalogDialogProps): JSX.Element {
  const catalog = useCatalog();
  const [filters, setFilters] = useState<CatalogFilters>({
    query: "",
    provider,
    freeOnly: false,
    noTraining: false,
  });

  return (
    <Dialog title="Model catalog" onClose={onClose}>
      <FiltersBar filters={filters} onChange={setFilters} />
      <CatalogList
        catalog={catalog}
        filters={filters}
        onUse={(model) => {
          onPick(model);
          onClose();
        }}
      />
    </Dialog>
  );
}
