export const USAGE_SUMMARY_STRINGS = {
  usageLabel: "Usage",
  tokensTotal: (count: string) => `${count} tokens`,
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  reasoning: "Reasoning",
  costNotReported: (provider: string) =>
    `${provider} has not reported cost for this session`,
  usageNotReported: (provider: string) =>
    `${provider} has not reported usage for this session`,
  tokensNotReported: (provider: string) =>
    `${provider} has not reported tokens for this session`,
  noUsageYet: "No usage reported yet",
} as const;
