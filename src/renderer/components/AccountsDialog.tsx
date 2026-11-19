import { useState, type JSX } from "react";

import { ApiAuth } from "../../domain/apiProviders";
import { ProviderId } from "../../domain/types";
import type { AccountView } from "../../shared/views";
import type { IpcClient } from "../ipc";
import {
  compactPath,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  providerOf,
  type SelectableProvider,
} from "../format";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";
import { useSuggestedDirectory } from "../useSuggestedDirectory";

import { ApiAccountDetails } from "./ApiAccountDetails";
import {
  ApiAccountFields,
  INITIAL_API_DRAFT,
  toApiParams,
  useVaultStatus,
  validateApiDraft,
  withPickedModel,
} from "./ApiAccountFields";
import { Dialog, type DialogProps } from "./Dialog";
import { ModelCatalogDialog } from "./ModelCatalogDialog";
import { SignIn } from "./SignIn";

interface AccountRowProps {
  account: AccountView;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMove: (id: string, direction: "up" | "down") => void;
  onRemove: (id: string) => void;
}

interface AddFormProps {
  client: IpcClient;
}

function AccountRow({
  account,
  isFirst,
  isLast,
  disabled,
  onMove,
  onRemove,
}: AccountRowProps): JSX.Element {
  return (
    <li className="account-row" data-provider={account.provider}>
      <div className="account-line">
        <span className="dot" />
        <span className="account-label">{account.label}</span>
        <small title={account.configDir}>
          {compactPath(account.configDir)}
        </small>
        <button
          type="button"
          className="btn"
          aria-label="Move up"
          disabled={disabled || isFirst}
          onClick={() => {
            onMove(account.id, "up");
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Move down"
          disabled={disabled || isLast}
          onClick={() => {
            onMove(account.id, "down");
          }}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Remove"
          disabled={disabled}
          onClick={() => {
            onRemove(account.id);
          }}
        >
          ✕
        </button>
      </div>
      {account.api === null ? (
        <SignIn account={account} />
      ) : (
        <ApiAccountDetails account={account} api={account.api} />
      )}
    </li>
  );
}

interface AgentSelectProps {
  provider: SelectableProvider;
  onChange: (provider: SelectableProvider) => void;
}

function AgentSelect({ provider, onChange }: AgentSelectProps): JSX.Element {
  return (
    <>
      <label htmlFor="account-provider">Agent</label>
      <select
        id="account-provider"
        value={provider}
        onChange={(event) => {
          onChange(providerOf(event.target.value));
        }}
      >
        {PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {PROVIDER_LABELS[id]}
          </option>
        ))}
      </select>
    </>
  );
}

function AddAccountForm({ client }: AddFormProps): JSX.Element {
  const add = useAsyncAction();
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<SelectableProvider>(
    ProviderId.claude,
  );
  const [api, setApi] = useState(INITIAL_API_DRAFT);
  const [browsing, setBrowsing] = useState(false);
  const suggestion = useSuggestedDirectory(client);
  const { configDir, setConfigDir } = suggestion;
  const isApi = provider === ProviderId.opencode;
  const needsVault = isApi && api.auth === ApiAuth.apiKey;
  const vault = useVaultStatus(client, isApi);
  const error = add.error ?? suggestion.error;

  const submit = async (): Promise<void> => {
    const invalid = label.trim() === "" ? "Label is required" : null;
    const apiInvalid = isApi ? validateApiDraft(api) : null;
    if (invalid !== null || apiInvalid !== null) {
      add.setError(invalid ?? apiInvalid);
      return;
    }
    await add.run(async () => {
      await client.request(
        "accounts/add",
        isApi
          ? { label, configDir, provider, ...toApiParams(api) }
          : { label, configDir, provider },
      );
      setLabel("");
      setApi((current) => ({ ...current, model: "", apiKey: "" }));
      await suggestion.refresh();
    });
  };

  return (
    <>
      <form
        className="add-account"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <AgentSelect
          provider={provider}
          onChange={(next) => {
            setProvider(next);
            if (next !== ProviderId.opencode) {
              setApi(INITIAL_API_DRAFT);
            }
          }}
        />
        <label htmlFor="account-label">Label</label>
        <input
          id="account-label"
          type="text"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
        <label htmlFor="account-config-dir">Config directory</label>
        <input
          id="account-config-dir"
          type="text"
          value={configDir}
          onChange={(event) => {
            setConfigDir(event.target.value);
          }}
        />
        {isApi && (
          <ApiAccountFields
            draft={api}
            vault={vault}
            onChange={setApi}
            onBrowse={() => {
              setBrowsing(true);
            }}
          />
        )}
        <button
          type="submit"
          className="btn pri"
          disabled={add.pending || (needsVault && vault?.available === false)}
        >
          Add account
        </button>
        {error !== null && <p className="error">{error}</p>}
      </form>
      {browsing && (
        <ModelCatalogDialog
          provider={api.provider}
          onPick={(model) => {
            setApi((current) => withPickedModel(current, model));
          }}
          onClose={() => {
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}

export function AccountsDialog({ onClose }: DialogProps): JSX.Element {
  const { client, state } = useApp();
  const manage = useAsyncAction();
  const accounts = state.snapshot?.accounts ?? [];

  return (
    <Dialog title="Accounts" onClose={onClose}>
      <ul className="account-list">
        {accounts.map((account, index) => (
          <AccountRow
            key={account.id}
            account={account}
            isFirst={index === 0}
            isLast={index === accounts.length - 1}
            disabled={manage.pending}
            onMove={(id, direction) => {
              void manage.run(() =>
                client.request("accounts/move", { id, direction }),
              );
            }}
            onRemove={(id) => {
              void manage.run(() => client.request("accounts/remove", { id }));
            }}
          />
        ))}
      </ul>
      {manage.error !== null && <p className="error">{manage.error}</p>}
      <AddAccountForm client={client} />
    </Dialog>
  );
}
