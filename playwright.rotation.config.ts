import { defineConfig } from "@playwright/test";

const TEST_TIMEOUT_MS = 240_000;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: [
    "rotation.spec.ts",
    "flowRun.spec.ts",
    "flowLibrary.spec.ts",
    "orchestrator.spec.ts",
    "agentEditor.spec.ts",
    "codexRotation.spec.ts",
    "opencodeRotation.spec.ts",
    "agyRotation.spec.ts",
    "agyEditDiff.spec.ts",
  ],
  timeout: TEST_TIMEOUT_MS,
  workers: 1,
  reporter: "list",
});
