import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ProviderId } from "../../domain/types";

import { ContextMeter } from "./ContextMeter";

afterEach(cleanup);

it("shows_not_reported_without_usage", () => {
  const { container } = render(
    <ContextMeter usage={null} provider={ProviderId.gemini} />,
  );

  expect(screen.getByText("Context not reported")).toBeTruthy();
  expect(container.querySelector("meter")).toBeNull();
  const meter = container.querySelector(".context-meter");
  expect(meter?.getAttribute("title")).toBe(
    "gemini has not reported context usage for this session",
  );
});

it("context_meter_hides_meter_without_limit", () => {
  const { container } = render(
    <ContextMeter
      usage={{ usedTokens: 12_345, limitTokens: null }}
      provider={ProviderId.codex}
    />,
  );

  expect(screen.getByText("12.3K tokens in context")).toBeTruthy();
  expect(container.querySelector("meter")).toBeNull();
  expect(
    container.querySelector(".context-meter")?.getAttribute("title"),
  ).toBeNull();
});
