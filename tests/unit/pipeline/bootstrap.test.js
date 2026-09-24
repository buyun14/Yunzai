import { describe, expect, it } from "vitest"
import { bootstrapPipeline } from "../../../lib/pipeline/bootstrap.js"
import { PipelineContext } from "../../../lib/pipeline/context.js"
import { PipelineScheduler } from "../../../lib/pipeline/scheduler.js"
import { STAGES_ORDER } from "../../../lib/pipeline/stage-order.js"
import { createConfigStub } from "../../helpers/config.js"
import { createLoaderStub } from "../../helpers/pipeline.js"

describe("bootstrap：装配完整性", () => {
  it("内置阶段全部被 import 进来，数量与 STAGES_ORDER 一致", () => {
    const stages = bootstrapPipeline()
    expect(stages).toHaveLength(STAGES_ORDER.length)
  })

  it("返回的顺序与 STAGES_ORDER 严格一致", () => {
    expect(bootstrapPipeline().map(StageClass => StageClass.name)).toEqual(STAGES_ORDER)
  })

  it("STAGES_ORDER 里没有 RespondStage（发送不是独立阶段）", () => {
    expect(STAGES_ORDER).not.toContain("RespondStage")
  })

  it("可以重复调用，不产生副作用", () => {
    const first = bootstrapPipeline()
    const second = bootstrapPipeline()
    expect(second.map(c => c.name)).toEqual(first.map(c => c.name))
  })
})

describe("bootstrap：与调度器接线", () => {
  it("调度器按 bootstrap 的顺序实例化全阶段", async () => {
    const ctx = new PipelineContext({
      loader: createLoaderStub(),
      profileKey: "boot",
      cfg: createConfigStub(),
    })

    await new PipelineScheduler(ctx).initialize()

    expect(ctx.stages.map(stage => stage.constructor.name)).toEqual(STAGES_ORDER)
  })

  it("实例化后每个阶段都拿到了同一个上下文", async () => {
    const ctx = new PipelineContext({
      loader: createLoaderStub(),
      profileKey: "boot",
      cfg: createConfigStub(),
    })

    await new PipelineScheduler(ctx).initialize()

    for (const stage of ctx.stages) expect(stage.ctx).toBe(ctx)
  })

  it("RateLimitCommitStage 能取到 RateLimitCheckStage（顺序保证）", async () => {
    const ctx = new PipelineContext({
      loader: createLoaderStub(),
      profileKey: "boot",
      cfg: createConfigStub(),
    })

    await new PipelineScheduler(ctx).initialize()

    const commit = ctx.stages.find(stage => stage.constructor.name === "RateLimitCommitStage")
    const check = ctx.stages.find(stage => stage.constructor.name === "RateLimitCheckStage")
    expect(commit.rateLimit).toBe(check)
  })
})
