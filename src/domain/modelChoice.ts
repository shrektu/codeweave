import { MODEL_AUTO } from "./constants";
import { ProviderId, type Account } from "./types";

const API_PROVIDER_SEPARATOR = "/";

export interface ModelChoice {
  readonly provider: ProviderId;
  readonly model: string;
}

function opencodeModelOf(account: Account, model: string): string | null {
  const separator = model.indexOf(API_PROVIDER_SEPARATOR);
  if (separator < 0 || model.slice(0, separator) !== account.api?.provider) {
    return null;
  }
  const modelId = model.slice(separator + API_PROVIDER_SEPARATOR.length);
  return modelId === "" ? null : modelId;
}

export function isAutoModel(model: string): boolean {
  return model.trim().toLowerCase() === MODEL_AUTO;
}

export function explicitModelFor(
  account: Account,
  choice: ModelChoice | null,
): string | null {
  if (choice?.provider !== account.provider) {
    return null;
  }
  const model = choice.model.trim();
  if (model === "" || isAutoModel(model)) {
    return null;
  }
  return account.provider === ProviderId.opencode
    ? opencodeModelOf(account, model)
    : model;
}

export function explicitModelOn(
  accounts: readonly Account[],
  accountId: string,
  choice: ModelChoice | null,
): string | null {
  const account = accounts.find((item) => item.id === accountId);
  return account === undefined ? null : explicitModelFor(account, choice);
}
