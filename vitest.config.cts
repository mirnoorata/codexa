import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".codex/cache/vite",
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // Several integration suites launch Git, Node, and MCP subprocess trees.
    // Bound file-level fan-out so host CPU discovery cannot multiply those
    // children into scheduler starvation and false deadline failures in CI.
    maxWorkers: 2,
    testTimeout: 30000
  }
});
