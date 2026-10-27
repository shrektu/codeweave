import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { App } from "../../src/renderer/App";

beforeEach(() => {
  window.codeweave = { gpuAccelerated: true };
});

afterEach(cleanup);

it("app_renders_three_columns", () => {
  render(<App />);

  expect(screen.getByRole("region", { name: "Konta" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Sesja" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Limity" })).toBeTruthy();
});
