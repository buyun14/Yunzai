import { defineConfig } from "vitest/config"

/**
 * 覆盖率统计的范围 = **改造涉及的核心模块**。
 *
 * 不做全仓覆盖率统计，理由：`lib/` 下大量代码是 vendored 第三方与
 * puppeteer / 渲染 / 适配器等需要真实环境才能跑的模块，
 * 把它们算进来只会得到一个很大的分母和一个没有指导意义的百分比。
 *
 * 这里的清单恰好是"阶段 1 / 阶段 2 / 阶段 3 / 阶段 4 改动过、且有单测覆盖"的那些文件——
 * 它们是后续重构最可能碰坏的地方，覆盖率对它们才有意义。
 *
 * ⚠️ 每完成一个阶段都要回来补这份清单。阶段 4 收尾时就发现过漏项：
 * `lib/message/` 与 `lib/adapter/` 是那一阶段新增的，却没有被任何 glob 覆盖，
 * 于是它们可以掉到 0% 而 CI 依旧全绿——门槛没覆盖到的代码等于没有门槛。
 */
const CORE_MODULES = [
  "lib/pipeline/**/*.js",
  "lib/event-bus.js",
  "lib/message/**/*.js",
  "lib/adapter/**/*.js",
  "lib/web/**/*.js",
  "lib/config/version.js",
  "lib/config/backup.js",
  "lib/config/migrate.js",
  "lib/config/diff.js",
  "lib/config/zip.js",
  "lib/config/archive.js",
  "lib/config/migrations/*.js",
  // 宿主配置的 schema 表（阶段 5 §3.2）。**纯数据 + 纯函数**，没有环境依赖，
  // 所以整个文件都该被覆盖到——它一旦漏出清单就可能在 0% 的情况下全绿。
  "lib/config/host-schema.js",
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
       * | Statements | 95.81% | 93 |
       * | Branches   | 90.65% | 88 |
       * | Functions  | 96.15% | 93 |
       * | Lines      | 97.42% | 95 |
       *
       * 留 2 个点而不是贴着实测值，是为了让“合理地新增一小段尚未测到的代码”
       * 不至于直接卡死 CI（否则会逼出“为了过门槛而凑测试”的反效果）。
       * 基线数字与已知缺口见 docs/refactor/03-engineering.md §3.4。
       *
       * 阶段 4 收尾时把 `lib/message` 与 `lib/adapter` 补进清单（见上），
       * 阶段 5 §3.1 又把被单测覆盖的那几个 `lib/config` 文件补进来
       * （**不能整个目录加**：`config.js` / `init.js` / `redis.js` 需要真实环境，
       * 算进来只会得到一个大分母）；两次都让实测值上升。
       * 阶段 5 §3.2 的 `host-schema.js` 是纯数据 + 纯函数，补进来后实测 100%，
       * 整体到 95.88 / 89.19 / 96.73 / 97.30。
       * 各目录自己的实测：`lib/message` 100 / 96.61 / 100 / 100，
       * `lib/adapter` 97.43 / 92.85 / 100 / 96.77，`lib/config` 96.36 / 88.13 / 100 / 96.87。
       */
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 93,
        lines: 95,
      },
    },
  },
})
