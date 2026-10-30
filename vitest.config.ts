import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const ROTATION_E2E_ENABLED = "1";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "src/shared/**/*.test.ts",
            "src/domain/**/*.test.ts",
            "src/backend/**/*.test.ts",
            "src/main/**/*.test.ts",
            "tests/acceptance/*.node.test.ts",
            "tests/fakes/*.node.test.ts",
          ],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "jsdom",
          environment: "jsdom",
          setupFiles: [
            "tests/setup/jsdomDialog.ts",
            "tests/setup/jsdomFlow.ts",
          ],
          include: [
            "src/renderer/**/*.test.{ts,tsx}",
            "tests/acceptance/*.dom.test.tsx",
          ],
        },
      },
      ...(process.env.CODEWEAVE_ROTATION_E2E === ROTATION_E2E_ENABLED
        ? [
            {
              test: {
                name: "rotation",
                environment: "node",
                include: [
                  "tests/e2e/rotation.node.test.ts",
                  "tests/e2e/codexRotation.node.test.ts",
                  "tests/e2e/opencodeRotation.node.test.ts",
                ],
              },
            },
          ]
        : []),
    ],
  },
});
