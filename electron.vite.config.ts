import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const srcPath = (...segments: string[]): string =>
  resolve(import.meta.dirname, "src", ...segments);

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: srcPath("main", "index.ts"),
          backend: srcPath("backend", "index.ts"),
          agyHook: srcPath("backend", "agy", "hook.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: srcPath("preload", "index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
