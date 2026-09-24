import { defineConfig } from "vitest/config"

/**
 * 覆盖率统计的范围 = **改造涉及的核心模块**。
 *
 * 不做全仓覆盖率统计，理由：`lib/` 下大量代码是 vendored 第三方与
 * puppeteer / 渲染 / 适配器等需要真实环境才能跑的模块，
 * 把它们算进来只会得到一个很大的分母和一个没有指导意义的百分比。
 *
 * 这里的清单恰好是"阶段 1 / 阶段 2 改动过、且有单测覆盖"的那些文件——
 * 它们是后续重构最可能碰坏的地方，覆盖率对它们才有意义。
 */
const CORE_MODULES = [
  "lib/pipeline/**/*.js",
  "lib/event-bus.js",
  "lib/plugins/schema.js",
  "lib/plugins/metadata.js",
  "lib/plugins/version.js",
  "lib/plugins/plugin-config.js",
  "lib/plugins/rule.js",
]

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    // 在导入被测模块之前装好 L0 全局变量替身（见 tests/helpers/env.js）
    setupFiles: ["tests/helpers/setup.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: CORE_MODULES,
      // 类型声明里没有可执行代码，算进来只会拉低分母
      exclude: ["**/*.d.ts"],
      /**
       * 门槛取**实测基线下浮 2 个点**，意图是“只允许下降不允许回归”，
       * 而不是追求精度：
       *
       * | 指标 | 2026-09-24 实测 | 门槛 |
       * |---|---|---|
       * | Statements | 95.22% | 93 |
       * | Branches   | 89.66% | 85 |
       * | Functions  | 94.23% | 92 |
       * | Lines      | 96.91% | 94 |
       *
       * 留 2 个点而不是贴着实测值，是为了让“合理地新增一小段尚未测到的代码”
       * 不至于直接卡死 CI（否则会逼出“为了过门槛而凑测试”的反效果）。
       * 基线数字与已知缺口见 docs/refactor/03-engineering.md §3.4。
       */
      thresholds: {
        statements: 93,
        branches: 85,
        functions: 92,
        lines: 94,
      },
    },
  },
})
