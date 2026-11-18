import {
  declaredModels,
  type OpencodeCredentials,
  type SessionConfigInput,
} from "../config";
import {
  FILE_REFERENCE_PREFIX,
  FILE_REFERENCE_SUFFIX,
  OPENAI_COMPATIBLE_PACKAGE,
  SHARE_DISABLED,
} from "../constants";

import {
  OpencodeV2Action,
  OpencodeV2Effect,
  POLICY_PROVIDER_USE,
  RESOURCE_WILDCARD,
  UPDATE_DISABLED,
} from "./constants";

export interface OpencodeV2Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: OpencodeV2Effect;
}

export interface OpencodeV2ProviderConfig {
  readonly package?: string;
  readonly settings: { readonly apiKey: string; readonly baseURL?: string };
  readonly models?: Readonly<Record<string, { readonly name: string }>>;
}

export interface OpencodeV2SessionConfig {
  readonly model: string;
  readonly update: typeof UPDATE_DISABLED;
  readonly share: typeof SHARE_DISABLED;
  readonly agents: { readonly title: { readonly model: string } };
  readonly permissions: readonly OpencodeV2Rule[];
  readonly policies: readonly OpencodeV2Rule[];
  readonly providers: Readonly<Record<string, OpencodeV2ProviderConfig>>;
}

const ASKED_ACTIONS: readonly string[] = [
  OpencodeV2Action.shell,
  OpencodeV2Action.edit,
  OpencodeV2Action.webfetch,
  OpencodeV2Action.externalDirectory,
];

function providerConfig(
  credentials: OpencodeCredentials,
  keyFilePath: string,
): OpencodeV2ProviderConfig {
  const apiKey = `${FILE_REFERENCE_PREFIX}${keyFilePath}${FILE_REFERENCE_SUFFIX}`;
  if (credentials.baseUrl === null) {
    return { settings: { apiKey } };
  }
  return {
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: { apiKey, baseURL: credentials.baseUrl },
    models: declaredModels(credentials),
  };
}

export function buildV2SessionConfig(
  input: SessionConfigInput,
): OpencodeV2SessionConfig {
  const { credentials, keyFilePath } = input;
  const qualified = `${credentials.providerId}/${credentials.model}`;
  return {
    model: qualified,
    update: UPDATE_DISABLED,
    share: SHARE_DISABLED,
    agents: { title: { model: qualified } },
    permissions: ASKED_ACTIONS.map((action) => ({
      action,
      resource: RESOURCE_WILDCARD,
      effect: OpencodeV2Effect.ask,
    })),
    policies: [
      {
        action: POLICY_PROVIDER_USE,
        resource: RESOURCE_WILDCARD,
        effect: OpencodeV2Effect.deny,
      },
      {
        action: POLICY_PROVIDER_USE,
        resource: credentials.providerId,
        effect: OpencodeV2Effect.allow,
      },
    ],
    providers: {
      [credentials.providerId]: providerConfig(credentials, keyFilePath),
    },
  };
}
