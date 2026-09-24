/**
 * lint-staged 配置。
 *
 * ## 为什么提交钩子里只跑 prettier，不跑 eslint
 *
 * `eslint --fix` 的退出码会包含**基线里已有的**报错，而不区分是不是本次改出来的。
 * 阶段 0 记录的 16 个 error 里，有几个位于改造必须反复触碰的文件
 * （例如 `lib/plugins/loader.js` 的 `no-setter-return`），
 * 一旦把 eslint 放进提交钩子，这些文件就会**任何改动都无法提交**。
 *
 * 因此：
 * - 提交时只做格式化（全仓已是 prettier-clean，不会误拦）；
 * - ESLint 在 CI 中跑（见 `.github/workflows/ci.yml`），当前为 `continue-on-error`；
 * - 等 `docs/refactor/baseline/static-analysis.md` 的数字归零后，
 *   再把 eslint 加回这里并把 CI 的 `continue-on-error` 去掉（阶段 3）。
 */
export default {
  "*.js": ["prettier --write"],
  "*.{json,yml,yaml,md}": ["prettier --write"],
}
