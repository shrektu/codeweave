import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
          ],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "jsdom",
          environment: "jsdom",
          setupFiles: ["tests/setup/jsdomDialog.ts"],
          include: [
            "src/renderer/**/*.test.{ts,tsx}",
            "tests/acceptance/*.dom.test.tsx",
          ],
        },
      },
    ],
  },
});
