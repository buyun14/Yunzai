/**
 * lint-staged 配置。
 *
 * ## 为什么提交钩子里现在会跑 eslint（阶段 3 第 8 步的变化）
 *
 * 阶段 0 时只跑 prettier，因为 `eslint` 的退出码会把**基线里已有的**报错一并算进来、
 * 不区分是不是本次改出来的；当时 16 个 error 里有几个正落在改造必须反复触碰的文件上
 * （例如 `lib/plugins/loader.js` 的 `no-setter-return`），一旦放进钩子，
 * 这些文件就会**任何改动都无法提交**。
 *
 * 阶段 3 第 8 步把基线清零了（0 error / 0 warning），这个前提随之消失：
 * 现在退出码只可能来自本次改动，放进钩子才真正起到"拦截新增违规"的作用。
 * 同时去掉了 `.github/workflows/ci.yml` 里 ESLint 步骤的 `continue-on-error`。
 *
 * ## 为什么用 `eslint` 而不是 `eslint --fix`
 *
 * 仓库策略是"风格交给 Prettier"，ESLint 只保留少数能捕获真实缺陷的规则
 * （见 `eslint.config.js`），这些规则基本没有自动修复能力。加 `--fix` 会让人
 * 误以为有东西被自动改好了；真正承担自动格式化的是同一行里的 prettier。
 */
export default {
  "*.js": ["eslint", "prettier --write"],
  "*.mjs": ["eslint", "prettier --write"],
  "*.{json,yml,yaml,md}": ["prettier --write"],
}
