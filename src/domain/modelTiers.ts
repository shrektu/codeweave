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
}

export const TIERS_CHECKED_ON = "2026-11-17";

const GROQ_SOURCE = "https://console.groq.com/docs/models";
const CEREBRAS_OSS_SOURCE =
  "https://inference-docs.cerebras.ai/models/openai-oss";
const CEREBRAS_QWEN_SOURCE =
  "https://inference-docs.cerebras.ai/models/qwen-3.8-27b";
const GOOGLE_SOURCE = "https://aistudio.google.com/docs/pricing";
const MISTRAL_SOURCE = "https://docs.mistral.ai/inference/pricing";
const ZAI_SOURCE = "https://docs.z.ai/guides/overview/pricing";
const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";

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
];
