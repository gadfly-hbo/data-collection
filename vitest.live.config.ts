import { defineConfig } from "vitest/config";

/** live 冒烟独立配置：npm run test:live 才跑（真实网络 + API Key）。 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
