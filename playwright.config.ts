import { defineConfig } from "@playwright/test";

const TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: [
    "rotation.spec.ts",
    "codexRotation.spec.ts",
    "opencodeRotation.spec.ts",
  ],
  timeout: TEST_TIMEOUT_MS,
  workers: 1,
  reporter: "list",
});
