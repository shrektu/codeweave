export const ApiProviderId = {
  groq: "groq",
  cerebras: "cerebras",
  openrouter: "openrouter",
  google: "google",
  mistral: "mistral",
  zai: "zai",
  deepseek: "deepseek",
  moonshotai: "moonshotai",
  opencodeGo: "opencode-go",
  opencodeZen: "opencode-zen",
  custom: "custom",
} as const;
export type ApiProviderId = (typeof ApiProviderId)[keyof typeof ApiProviderId];

export const ApiAuth = {
  apiKey: "api_key",
  consoleLogin: "console_login",
} as const;
export type ApiAuth = (typeof ApiAuth)[keyof typeof ApiAuth];

export const ApiTier = {
  flatRate: "flat_rate",
  free: "free",
  paid: "paid",
} as const;
export type ApiTier = (typeof ApiTier)[keyof typeof ApiTier];

export const FreeModels = {
  all: "all",
  marked: "marked",
} as const;
export type FreeModels = (typeof FreeModels)[keyof typeof FreeModels];

export const TRAINING_UNKNOWN = "unknown";

export interface ApiProviderInfo {
  readonly label: string;
  readonly opencodeId: string;
  readonly tier: ApiTier;
  readonly freeModels: FreeModels;
  readonly trainsOnData: boolean | typeof TRAINING_UNKNOWN;
  readonly defaultRotation: boolean;
  readonly consoleLogin: boolean;
  readonly keyEnvNames: readonly string[];
  readonly accountHint?: string;
}

const OPENCODE_GO_HINT =
  "API key from the OpenCode Console (Go, Go Plus or Go Teams), or the Console login. If Extra Usage is on there, a reached limit is billed to your balance and Codeweave does not rotate.";

const OPENCODE_ZEN_HINT =
  "Pay-as-you-go models from the OpenCode Console. Sign in with a Console API key or the Console login.";

export const API_PROVIDERS: Readonly<Record<ApiProviderId, ApiProviderInfo>> = {
  [ApiProviderId.groq]: {
    label: "Groq",
    opencodeId: "groq",
    tier: ApiTier.free,
    freeModels: FreeModels.all,
    trainsOnData: false,
    defaultRotation: true,
    consoleLogin: false,
    keyEnvNames: ["GROQ_API_KEY"],
  },
  [ApiProviderId.cerebras]: {
    label: "Cerebras",
    opencodeId: "cerebras",
    tier: ApiTier.free,
    freeModels: FreeModels.all,
    trainsOnData: false,
    defaultRotation: true,
    consoleLogin: false,
    keyEnvNames: ["CEREBRAS_API_KEY"],
  },
  [ApiProviderId.openrouter]: {
    label: "OpenRouter",
    opencodeId: "openrouter",
    tier: ApiTier.free,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    consoleLogin: false,
    keyEnvNames: ["OPENROUTER_API_KEY"],
  },
  [ApiProviderId.google]: {
    label: "Google AI Studio",
    opencodeId: "google",
    tier: ApiTier.free,
    freeModels: FreeModels.all,
    trainsOnData: true,
    defaultRotation: true,
    consoleLogin: false,
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
    freeModels: FreeModels.all,
    trainsOnData: true,
    defaultRotation: true,
    consoleLogin: false,
    keyEnvNames: ["MISTRAL_API_KEY"],
  },
  [ApiProviderId.zai]: {
    label: "Z.ai",
    opencodeId: "zai",
    tier: ApiTier.free,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    consoleLogin: false,
    keyEnvNames: ["ZHIPU_API_KEY"],
  },
  [ApiProviderId.deepseek]: {
    label: "DeepSeek",
    opencodeId: "deepseek",
    tier: ApiTier.paid,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: false,
    consoleLogin: false,
    keyEnvNames: ["DEEPSEEK_API_KEY"],
  },
  [ApiProviderId.moonshotai]: {
    label: "Kimi (Moonshot)",
    opencodeId: "moonshotai",
    tier: ApiTier.paid,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: false,
    consoleLogin: false,
    keyEnvNames: ["MOONSHOT_API_KEY"],
  },
  [ApiProviderId.opencodeGo]: {
    label: "OpenCode Go",
    opencodeId: "opencode-go",
    tier: ApiTier.flatRate,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    consoleLogin: true,
    keyEnvNames: ["OPENCODE_API_KEY"],
    accountHint: OPENCODE_GO_HINT,
  },
  [ApiProviderId.opencodeZen]: {
    label: "OpenCode Zen",
    opencodeId: "opencode",
    tier: ApiTier.paid,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: false,
    consoleLogin: true,
    keyEnvNames: ["OPENCODE_API_KEY"],
    accountHint: OPENCODE_ZEN_HINT,
  },
  [ApiProviderId.custom]: {
    label: "Custom OpenAI-compatible",
    opencodeId: "custom",
    tier: ApiTier.free,
    freeModels: FreeModels.marked,
    trainsOnData: TRAINING_UNKNOWN,
    defaultRotation: true,
    consoleLogin: false,
    keyEnvNames: [],
  },
};

export const PROVIDER_KEY_ENV_NAMES: readonly string[] = [
  ...new Set(Object.values(API_PROVIDERS).flatMap((info) => info.keyEnvNames)),
];
