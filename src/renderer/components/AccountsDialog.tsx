import { useState, type JSX } from "react";

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
import { loginCommands } from "../loginCommand";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";
import { useSuggestedDirectory } from "../useSuggestedDirectory";

import { Dialog, type DialogProps } from "./Dialog";

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

function SignIn({ account }: { account: AccountView }): JSX.Element | null {
  const commands = loginCommands(account.provider, account.configDir);
  if (commands === null) {
    return null;
  }
  return (
    <div className="signin">
      <b>Sign in</b>
      <p>{commands.hint}</p>
      <div className="cmd">
        <span>bash</span>
        <code>{commands.bash}</code>
      </div>
      <div className="cmd">
        <span>PowerShell</span>
        <code>{commands.powershell}</code>
      </div>
    </div>
  );
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
      <SignIn account={account} />
    </li>
  );
}

function AddAccountForm({ client }: AddFormProps): JSX.Element {
  const add = useAsyncAction();
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<SelectableProvider>(
    ProviderId.claude,
  );
  const suggestion = useSuggestedDirectory(client);
  const { configDir, setConfigDir } = suggestion;
  const error = add.error ?? suggestion.error;

  const submit = async (): Promise<void> => {
    if (label.trim() === "") {
      add.setError("Label is required");
      return;
    }
    const added = await add.run(async () => {
      await client.request("accounts/add", { label, configDir, provider });
      await suggestion.refresh();
    });
    if (added) {
      setLabel("");
    }
  };

  return (
    <form
      className="add-account"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="account-provider">Agent</label>
      <select
        id="account-provider"
        value={provider}
        onChange={(event) => {
          setProvider(providerOf(event.target.value));
        }}
      >
        {PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {PROVIDER_LABELS[id]}
          </option>
        ))}
      </select>
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
      <button type="submit" className="btn pri" disabled={add.pending}>
        Add account
      </button>
      {error !== null && <p className="error">{error}</p>}
    </form>
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
