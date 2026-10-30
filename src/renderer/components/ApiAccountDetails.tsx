import { useId, useState, type JSX } from "react";

import { API_PROVIDERS } from "../../domain/apiProviders";
import type { AccountView } from "../../shared/views";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

interface ApiAccountDetailsProps {
  account: AccountView;
  api: NonNullable<AccountView["api"]>;
}

interface ReplaceKeyFormProps {
  accountId: string;
  onSaved: () => void;
}

function ReplaceKeyForm({
  accountId,
  onSaved,
}: ReplaceKeyFormProps): JSX.Element {
  const { client } = useApp();
  const save = useAsyncAction();
  const [apiKey, setApiKey] = useState("");
  const inputId = useId();

  const submit = async (): Promise<void> => {
    const saved = await save.run(() =>
      client.request("accounts/setKey", { id: accountId, apiKey }),
    );
    if (saved) {
      setApiKey("");
      onSaved();
    }
  };

  return (
    <form
      className="replace-key"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId}>New API key</label>
      <input
        id={inputId}
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(event) => {
          setApiKey(event.target.value);
        }}
      />
      <button
        type="submit"
        className="btn pri"
        disabled={save.pending || apiKey === ""}
      >
        Save key
      </button>
      {save.error !== null && <p className="error">{save.error}</p>}
    </form>
  );
}

export function ApiAccountDetails({
  account,
  api,
}: ApiAccountDetailsProps): JSX.Element {
  const [replacing, setReplacing] = useState(false);
  return (
    <div className="api-details">
      <div className="api-summary">
        <span>{API_PROVIDERS[api.provider].label}</span>
        <code>{api.model}</code>
        <span>{api.rotation ? "Rotation on" : "Rotation off"}</span>
        <span>
          {account.keyHint === null
            ? "No key saved"
            : `Key …${account.keyHint}`}
        </span>
        <button
          type="button"
          className="btn"
          aria-expanded={replacing}
          onClick={() => {
            setReplacing((open) => !open);
          }}
        >
          Replace key
        </button>
      </div>
      {replacing && (
        <ReplaceKeyForm
          accountId={account.id}
          onSaved={() => {
            setReplacing(false);
          }}
        />
      )}
    </div>
  );
}
