import { ApiProviderId } from "./apiProviders";
import { TaskClass } from "./taskClass";

export interface ModelTier {
  readonly provider: ApiProviderId;
  readonly modelId: string;
  readonly taskClass: TaskClass;
  readonly free: boolean;
  readonly priceInUsdPerMTok: number | null;
  readonly priceOutUsdPerMTok: number | null;
  readonly sourceUrl: string;
  readonly checkedOn: string;
  readonly requestsPer5h?: number;
}

export const TIERS_CHECKED_ON = "2026-11-17";
export const GO_TIERS_CHECKED_ON = "2026-11-18";
export const GO_HEAVY_BELOW_REQUESTS = 500;
export const GO_LIGHT_FROM_REQUESTS = 3000;

export function classByAllowance(requestsPer5h: number): TaskClass {
  if (requestsPer5h < GO_HEAVY_BELOW_REQUESTS) {
    return TaskClass.heavy;
  }
  return requestsPer5h >= GO_LIGHT_FROM_REQUESTS
    ? TaskClass.light
    : TaskClass.standard;
}

const GROQ_SOURCE = "https://console.groq.com/docs/models";
const CEREBRAS_OSS_SOURCE =
  "https://inference-docs.cerebras.ai/models/openai-oss";
const CEREBRAS_QWEN_SOURCE =
  "https://inference-docs.cerebras.ai/models/qwen-3.8-27b";
const GOOGLE_SOURCE = "https://aistudio.google.com/docs/pricing";
const MISTRAL_SOURCE = "https://docs.mistral.ai/inference/pricing";
const ZAI_SOURCE = "https://docs.z.ai/guides/overview/pricing";
const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";
const GO_SOURCE = "https://opencode.ai/go";

interface GoModel {
  readonly modelId: string;
  readonly requestsPer5h: number;
  readonly priceIn: number;
  readonly priceOut: number;
}

const GO_MODELS: readonly GoModel[] = [
  { modelId: "kimi-k3", requestsPer5h: 98, priceIn: 3, priceOut: 15 },
  { modelId: "kimi-k3.1-pro", requestsPer5h: 147, priceIn: 2, priceOut: 10 },
  { modelId: "qwen3.8-max", requestsPer5h: 162, priceIn: 2, priceOut: 6 },
  { modelId: "grok-4.7", requestsPer5h: 169, priceIn: 2, priceOut: 6 },
  { modelId: "kimi-k2.7-code", requestsPer5h: 994, priceIn: 0.95, priceOut: 4 },
  { modelId: "glm-5.2", requestsPer5h: 792, priceIn: 1.4, priceOut: 4.4 },
  { modelId: "gpt-5.6-luna", requestsPer5h: 2050, priceIn: 0.2, priceOut: 1.2 },
  {
    modelId: "mimo-v2.6-flash",
    requestsPer5h: 30100,
    priceIn: 0.14,
    priceOut: 0.28,
  },
  { modelId: "longcat-2.0", requestsPer5h: 11400, priceIn: 0.3, priceOut: 1.2 },
  {
    modelId: "glm-5.3-flash",
    requestsPer5h: 6320,
    priceIn: 0.15,
    priceOut: 0.5,
  },
  {
    modelId: "qwen3.8-flash",
    requestsPer5h: 5400,
    priceIn: 0.15,
    priceOut: 0.47,
  },
  { modelId: "qwen3.7-plus", requestsPer5h: 4310, priceIn: 0.4, priceOut: 1.6 },
  { modelId: "hy3", requestsPer5h: 4300, priceIn: 0.14, priceOut: 0.58 },
  { modelId: "gpt-6-luna", requestsPer5h: 4230, priceIn: 0.1, priceOut: 0.5 },
  {
    modelId: "minimax-m3.1-flash",
    requestsPer5h: 3880,
    priceIn: 0.15,
    priceOut: 0.6,
  },
  {
    modelId: "claude-haiku-5-5",
    requestsPer5h: 3850,
    priceIn: 0.1,
    priceOut: 0.5,
  },
  {
    modelId: "mimo-v2.6-pro",
    requestsPer5h: 3260,
    priceIn: 0.435,
    priceOut: 0.87,
  },
  { modelId: "minimax-m3", requestsPer5h: 3210, priceIn: 0.3, priceOut: 1.2 },
];

function goTier(model: GoModel): ModelTier {
  return {
    provider: ApiProviderId.opencodeGo,
    modelId: model.modelId,
    taskClass: classByAllowance(model.requestsPer5h),
    free: false,
    priceInUsdPerMTok: model.priceIn,
    priceOutUsdPerMTok: model.priceOut,
    requestsPer5h: model.requestsPer5h,
    sourceUrl: GO_SOURCE,
    checkedOn: GO_TIERS_CHECKED_ON,
  };
}

export const MODEL_TIERS: readonly ModelTier[] = [
  {
    provider: ApiProviderId.groq,
    modelId: "openai/gpt-oss-20b",
    taskClass: TaskClass.light,
    free: true,
    priceInUsdPerMTok: 0.075,
    priceOutUsdPerMTok: 0.3,
    sourceUrl: GROQ_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.groq,
    modelId: "openai/gpt-oss-120b",
    taskClass: TaskClass.heavy,
    free: true,
    priceInUsdPerMTok: 0.15,
    priceOutUsdPerMTok: 0.6,
    sourceUrl: GROQ_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.cerebras,
    modelId: "gpt-oss-120b",
    taskClass: TaskClass.light,
    free: true,
    priceInUsdPerMTok: 0.35,
    priceOutUsdPerMTok: 0.75,
    sourceUrl: CEREBRAS_OSS_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.cerebras,
    modelId: "qwen-3.8-27b",
    taskClass: TaskClass.heavy,
    free: true,
    priceInUsdPerMTok: 0.99,
    priceOutUsdPerMTok: 1.49,
    sourceUrl: CEREBRAS_QWEN_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.google,
    modelId: "gemini-3.5-flash-lite",
    taskClass: TaskClass.light,
    free: true,
    priceInUsdPerMTok: 0.3,
    priceOutUsdPerMTok: 2.5,
    sourceUrl: GOOGLE_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.google,
    modelId: "gemini-3.8-flash",
    taskClass: TaskClass.heavy,
    free: true,
    priceInUsdPerMTok: 0.75,
    priceOutUsdPerMTok: 3.75,
    sourceUrl: GOOGLE_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.mistral,
    modelId: "ministral-8b-2512",
    taskClass: TaskClass.light,
    free: false,
    priceInUsdPerMTok: 0.15,
    priceOutUsdPerMTok: 0.15,
    sourceUrl: MISTRAL_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.mistral,
    modelId: "mistral-small-2603",
    taskClass: TaskClass.standard,
    free: false,
    priceInUsdPerMTok: 0.15,
    priceOutUsdPerMTok: 0.6,
    sourceUrl: MISTRAL_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.mistral,
    modelId: "mistral-large-4",
    taskClass: TaskClass.heavy,
    free: false,
    priceInUsdPerMTok: 0.7,
    priceOutUsdPerMTok: 2.1,
    sourceUrl: MISTRAL_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.zai,
    modelId: "glm-4.7-flash",
    taskClass: TaskClass.light,
    free: true,
    priceInUsdPerMTok: 0,
    priceOutUsdPerMTok: 0,
    sourceUrl: ZAI_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.zai,
    modelId: "glm-5.3-flash",
    taskClass: TaskClass.light,
    free: false,
    priceInUsdPerMTok: 0.15,
    priceOutUsdPerMTok: 0.5,
    sourceUrl: ZAI_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.zai,
    modelId: "glm-5.3-flashx",
    taskClass: TaskClass.standard,
    free: false,
    priceInUsdPerMTok: 0.37,
    priceOutUsdPerMTok: 1.25,
    sourceUrl: ZAI_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.zai,
    modelId: "glm-5.3",
    taskClass: TaskClass.heavy,
    free: false,
    priceInUsdPerMTok: 1.4,
    priceOutUsdPerMTok: 4.4,
    sourceUrl: ZAI_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.deepseek,
    modelId: "deepseek-flash",
    taskClass: TaskClass.light,
    free: false,
    priceInUsdPerMTok: 0.3,
    priceOutUsdPerMTok: 1.2,
    sourceUrl: DEEPSEEK_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: ApiProviderId.deepseek,
    modelId: "deepseek-v4-pro",
    taskClass: TaskClass.heavy,
    free: false,
    priceInUsdPerMTok: 1.32,
    priceOutUsdPerMTok: 3.96,
    sourceUrl: DEEPSEEK_SOURCE,
    checkedOn: TIERS_CHECKED_ON,
  },
  ...GO_MODELS.map(goTier),
];
