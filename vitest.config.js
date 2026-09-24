import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    // 在导入被测模块之前装好 L0 全局变量替身（见 tests/helpers/env.js）
    setupFiles: ["tests/helpers/setup.js"],
  },
})
