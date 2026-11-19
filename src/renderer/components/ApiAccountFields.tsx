import { useEffect, useState, type JSX } from "react";

import {
  API_PROVIDERS,
  ApiAuth,
  ApiProviderId,
} from "../../domain/apiProviders";
import type { ParamsMap } from "../../shared/protocol";
import type { VaultStatus } from "../../shared/vault";
import type { CatalogModel } from "../../shared/views";
import { errorMessage } from "../errorMessage";
import {
  API_AUTH_IDS,
  API_PROVIDER_IDS,
  parseApiAuth,
  parseApiProvider,
} from "../format";
import type { IpcClient } from "../ipc";

type ApiAddParams = Extract<ParamsMap["accounts/add"], { api: unknown }>;

export interface ApiDraft {
  provider: ApiProviderId;
  model: string;
  baseUrl: string;
  rotation: boolean;
  apiKey: string;
  auth: ApiAuth;
}

export const INITIAL_API_DRAFT: ApiDraft = {
  provider: ApiProviderId.groq,
  model: "",
  baseUrl: "",
  rotation: API_PROVIDERS[ApiProviderId.groq].defaultRotation,
  apiKey: "",
  auth: ApiAuth.apiKey,
};

const VAULT_UNAVAILABLE_MESSAGE = "Secure key storage is unavailable";
const SIGN_IN_LABELS: Readonly<Record<ApiAuth, string>> = {
  [ApiAuth.apiKey]: "API key",
  [ApiAuth.consoleLogin]: "OpenCode Console login",
};
const CONSOLE_LOGIN_HINT =
  "After adding the account, run the login command shown on its row. Codeweave never signs in for you. Needs opencode 2.2.5 or newer.";

export function validateApiDraft(draft: ApiDraft): string | null {
  if (draft.model.trim() === "") {
    return "Model is required";
  }
  if (draft.provider === ApiProviderId.custom && draft.baseUrl.trim() === "") {
    return "Base URL is required";
  }
  if (draft.auth === ApiAuth.apiKey && draft.apiKey === "") {
    return "API key is required";
  }
  return null;
}

function authFor(draft: ApiDraft, provider: ApiProviderId): ApiAuth {
  return API_PROVIDERS[provider].consoleLogin ? draft.auth : ApiAuth.apiKey;
}

export function withProvider(
  draft: ApiDraft,
  provider: ApiProviderId,
): ApiDraft {
  return {
    ...draft,
    provider,
    rotation: API_PROVIDERS[provider].defaultRotation,
    auth: authFor(draft, provider),
  };
}

export function withPickedModel(
  draft: ApiDraft,
  model: CatalogModel,
): ApiDraft {
  const rotation =
    model.providerId === draft.provider
      ? draft.rotation
      : API_PROVIDERS[model.providerId].defaultRotation;
  return {
    ...draft,
    provider: model.providerId,
    model: model.modelId,
    rotation,
    auth: authFor(draft, model.providerId),
  };
}

export function toApiParams(
  draft: ApiDraft,
): Pick<ApiAddParams, "api" | "apiKey"> {
  const api = {
    provider: draft.provider,
    model: draft.model.trim(),
    baseUrl:
      draft.provider === ApiProviderId.custom ? draft.baseUrl.trim() : null,
    rotation: draft.rotation,
    auth: draft.auth,
  };
  return draft.auth === ApiAuth.apiKey
    ? { api, apiKey: draft.apiKey }
    : { api };
}

export function useVaultStatus(
  client: IpcClient,
  active: boolean,
): VaultStatus | null {
  const [status, setStatus] = useState<VaultStatus | null>(null);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let current = true;
    void client
      .request("vault/status", {})
      .then((result) => {
        if (current) {
          setStatus(result);
        }
      })
      .catch((caught: unknown) => {
        if (current) {
          setStatus({ available: false, reason: errorMessage(caught) });
        }
      });
    return (): void => {
      current = false;
    };
  }, [client, active]);

  return status;
}

interface ApiAccountFieldsProps {
  draft: ApiDraft;
  vault: VaultStatus | null;
  onChange: (draft: ApiDraft) => void;
  onBrowse: () => void;
}

function ProviderSelect({
  draft,
  onChange,
}: Pick<ApiAccountFieldsProps, "draft" | "onChange">): JSX.Element {
  return (
    <>
      <label htmlFor="api-provider">API provider</label>
      <select
        id="api-provider"
        value={draft.provider}
        onChange={(event) => {
          const provider = parseApiProvider(event.target.value);
          if (provider !== null) {
            onChange(withProvider(draft, provider));
          }
        }}
      >
        {API_PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {API_PROVIDERS[id].label}
          </option>
        ))}
      </select>
    </>
  );
}

function SignInSelect({
  draft,
  onChange,
}: Pick<ApiAccountFieldsProps, "draft" | "onChange">): JSX.Element {
  return (
    <>
      <label htmlFor="api-auth">Sign in with</label>
      <select
        id="api-auth"
        value={draft.auth}
        onChange={(event) => {
          const auth = parseApiAuth(event.target.value);
          if (auth !== null) {
            onChange({ ...draft, auth });
          }
        }}
      >
        {API_AUTH_IDS.map((id) => (
          <option key={id} value={id}>
            {SIGN_IN_LABELS[id]}
          </option>
        ))}
      </select>
    </>
  );
}

function BaseUrlField({
  draft,
  onChange,
}: Pick<ApiAccountFieldsProps, "draft" | "onChange">): JSX.Element {
  return (
    <>
      <label htmlFor="api-base-url">Base URL</label>
      <input
        id="api-base-url"
        type="text"
        value={draft.baseUrl}
        onChange={(event) => {
          onChange({ ...draft, baseUrl: event.target.value });
        }}
      />
    </>
  );
}

export function ApiAccountFields({
  draft,
  vault,
  onChange,
  onBrowse,
}: ApiAccountFieldsProps): JSX.Element {
  const isCustom = draft.provider === ApiProviderId.custom;
  const hint = API_PROVIDERS[draft.provider].accountHint;
  return (
    <>
      <ProviderSelect draft={draft} onChange={onChange} />
      <label htmlFor="api-model">Model</label>
      <div className="inline-field">
        <input
          id="api-model"
          type="text"
          value={draft.model}
          onChange={(event) => {
            onChange({ ...draft, model: event.target.value });
          }}
        />
        <button type="button" className="btn" onClick={onBrowse}>
          Browse models
        </button>
      </div>
      {isCustom && <BaseUrlField draft={draft} onChange={onChange} />}
      <div className="check-field">
        <input
          id="api-rotation"
          type="checkbox"
          checked={draft.rotation}
          onChange={(event) => {
            onChange({ ...draft, rotation: event.target.checked });
          }}
        />
        <label htmlFor="api-rotation">Use in rotation</label>
      </div>
      {API_PROVIDERS[draft.provider].consoleLogin && (
        <SignInSelect draft={draft} onChange={onChange} />
      )}
      {draft.auth === ApiAuth.apiKey ? (
        <>
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(event) => {
              onChange({ ...draft, apiKey: event.target.value });
            }}
          />
          {hint !== undefined && <p className="agent-hint">{hint}</p>}
          {vault?.available === false && (
            <p className="error">{vault.reason ?? VAULT_UNAVAILABLE_MESSAGE}</p>
          )}
        </>
      ) : (
        <p className="agent-hint">{CONSOLE_LOGIN_HINT}</p>
      )}
    </>
  );
}
