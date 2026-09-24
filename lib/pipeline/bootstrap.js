/**
 * 内置阶段的显式装配点。
 *
 * # 为什么需要这个文件
 *
 * 阶段通过 `registerStage()` 主动把自己登记进 `registeredStages`，
 * 因此**必须有人 `import` 那些模块**，登记才会发生。`scheduler.js` 不能自己 import：
 * 它是被阶段依赖的（`stage.js`），互相 import 会形成环。
 *
 * 把 import 集中到本文件，与 `STAGES_ORDER` 形成一道**双人校验**：
 *
 * - 漏了 import → `assertStageCoverage` 报"缺少阶段"；
 * - 写了顺序却没写实现（或反之）→ 同样报错。
 *
 * 这不是多余的间接层：注册表是全局可变状态，若各阶段在别处被顺带 import，
 * "哪些阶段真的存在"就取决于 import 顺序，出问题时只会在运行期表现为
 * "某个策略悄悄不生效"。让它显式化，代价是一个 10 行的文件。
 *
 * # 用法
 *
 * 启动时必须先 import 本模块（或调用 `bootstrapPipeline()`），再 `new PipelineScheduler(ctx)`
 * 并 `await initialize()`。
 *
 * # 注意副作用
 *
 * `import "…/bootstrap.js"` 本身就是装配动作。单测要用自定义阶段集合时，
 * 不要经过这里——直接用 `registerStage()` / `clearRegisteredStages()`（见 `stage.js`）。
 */

import { registeredStages } from "./stage.js"
import { STAGES_ORDER, assertStageCoverage } from "./stage-order.js"

// 顺序无关紧要（顺序由 STAGES_ORDER 决定），但仍然按执行顺序排列，便于对照阅读
import "./stages/statistics.js"
import "./stages/whitelist-check.js"
import "./stages/profile-resolve.js"
import "./stages/rate-limit-check.js"
import "./stages/normalize.js"
import "./stages/rate-limit-commit.js"
import "./stages/pre-process.js"
import "./stages/wakeup-gate.js"
import "./stages/process.js"

/**
 * 校验当前注册表与 `STAGES_ORDER` 严格对应，并把排序后的阶段类返回给调度器。
 *
 * @returns {Array<new () => import("./stage.js").Stage>} 按执行顺序排列的阶段类
 */
export function bootstrapPipeline() {
  assertStageCoverage(registeredStages)

  return [...registeredStages].sort(
    (a, b) => STAGES_ORDER.indexOf(a.name) - STAGES_ORDER.indexOf(b.name),
  )
}
