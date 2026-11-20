import { expect, it } from "vitest";

import {
  renderUsageMarkdown,
  usageResponse,
} from "../../../tests/fakes/fakeClaudeUsage";

import { parseUsageMarkdown } from "./usageProbe";

const NOW_MS = Date.UTC(2026, 10, 19, 12, 0);

it("adapter_markdown_round_trips", () => {
  const markdown = renderUsageMarkdown(
    usageResponse({
      five_hour: { utilization: 30, resets_at: "2026-11-19T15:00:00Z" },
      seven_day: { utilization: 60, resets_at: "2026-11-21T20:00:00Z" },
      model_scoped: [
        {
          display_name: "Opus_4 [beta]",
          utilization: 100,
          resets_at: "2026-11-21T21:00:00Z",
        },
        { display_name: "Sonnet", utilization: 12.5, resets_at: null },
      ],
    }),
  );

  expect(parseUsageMarkdown(markdown, NOW_MS)).toEqual({
    kind: "limits",
    windows: [
      {
        id: "five_hour",
        scope: null,
        period: "five_hour",
        utilization: 0.3,
        resetsAt: 1_795_100_400,
        exhausted: false,
      },
      {
        id: "seven_day",
        scope: null,
        period: "seven_day",
        utilization: 0.6,
        resetsAt: 1_795_291_200,
        exhausted: false,
      },
      {
        id: "seven_day:opus_4 [beta]",
        scope: "Opus_4 [beta]",
        period: "seven_day",
        utilization: 1,
        resetsAt: 1_795_294_800,
        exhausted: true,
      },
      {
        id: "seven_day:sonnet",
        scope: "Sonnet",
        period: "seven_day",
        utilization: 0.125,
        resetsAt: null,
        exhausted: false,
      },
    ],
  });
});

it("adapter_markdown_without_rate_limits_is_no_limits", () => {
  const markdown = renderUsageMarkdown(usageResponse(null));

  expect(parseUsageMarkdown(markdown, NOW_MS)).toEqual({ kind: "no_limits" });
});
