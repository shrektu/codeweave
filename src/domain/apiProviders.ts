export const ApiProviderId = {
  groq: "groq",
  cerebras: "cerebras",
  openrouter: "openrouter",
  google: "google",
  mistral: "mistral",
  zai: "zai",
  deepseek: "deepseek",
  moonshotai: "moonshotai",
  custom: "custom",
} as const;
export type ApiProviderId = (typeof ApiProviderId)[keyof typeof ApiProviderId];

export const ApiTier = {
  free: "free",
  paid: "paid",
} as const;
export type ApiTier = (typeof ApiTier)[keyof typeof ApiTier];

export const TRAINING_UNKNOWN = "unknown";

export interface ApiProviderInfo {
  readonly label: string;
  readonly opencodeId: string;
  readonly tier: ApiTier;
  readonly trainsOnData: boolean | typeof TRAINING_UNKNOWN;
  readonly defaultRotation: boolean;
  readonly keyEnvNames: readonly string[];
}

export const API_PROVIDERS: Readonly<Record<ApiProviderId, ApiProviderInfo>> = {
  [ApiProviderId.groq]: {
    label: "Groq",
    opencodeId: "groq",
    tier: ApiTier.free,
    trainsOnData: false,
    defaultRotation: true,
    keyEnvNames: ["GROQ_API_KEY"],
  },
  [ApiProviderId.cerebras]: {
    label: "Cerebras",
    opencodeId: "cerebras",
    tier: ApiTier.free,
    trainsOnData: false,
    defaultRotation: true,
    keyEnvNames: ["CEREBRAS_API_KEY"],
  },
  [ApiProviderId.openrouter]: {
    label: "OpenRouter",
    opencodeId: "openrouter",
    tier: ApiTier.free,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    keyEnvNames: ["OPENROUTER_API_KEY"],
  },
  [ApiProviderId.google]: {
    label: "Google AI Studio",
    opencodeId: "google",
    tier: ApiTier.free,
    trainsOnData: true,
    defaultRotation: true,
    keyEnvNames: [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ],
  },
  [ApiProviderId.mistral]: {
    label: "Mistral",
    opencodeId: "mistral",
    tier: ApiTier.free,
    trainsOnData: true,
    defaultRotation: true,
    keyEnvNames: ["MISTRAL_API_KEY"],
  },
  [ApiProviderId.zai]: {
    label: "Z.ai",
    opencodeId: "zai",
    tier: ApiTier.free,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    keyEnvNames: ["ZHIPU_API_KEY"],
  },
  [ApiProviderId.deepseek]: {
    label: "DeepSeek",
    opencodeId: "deepseek",
    tier: ApiTier.paid,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: false,
    keyEnvNames: ["DEEPSEEK_API_KEY"],
  },
  [ApiProviderId.moonshotai]: {
    label: "Kimi (Moonshot)",
    opencodeId: "moonshotai",
    tier: ApiTier.paid,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: false,
    keyEnvNames: ["MOONSHOT_API_KEY"],
  },
  [ApiProviderId.custom]: {
    label: "Custom OpenAI-compatible",
    opencodeId: "custom",
    tier: ApiTier.free,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    keyEnvNames: [],
  },
};

export function excludedByCompanyCode(provider: ApiProviderId): boolean {
  return API_PROVIDERS[provider].trainsOnData !== false;
}

export const PROVIDER_KEY_ENV_NAMES: readonly string[] = Object.values(
  API_PROVIDERS,
).flatMap((info) => info.keyEnvNames);
