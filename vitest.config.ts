import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node 25 内建类型剥离：直接跑 .ts，无需转译
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**"],
    testTimeout: 15000,
  },
});
