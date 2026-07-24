import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".codex/cache/vite",
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 30000
  }
});
