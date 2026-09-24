/**
 * 全局测试初始化。
 *
 * 由 `vitest.config.js` 的 `setupFiles` 引入，保证每个测试文件在导入被测模块之前
 * 就已经装好 L0 全局变量替身。
 */
import { beforeAll } from "vitest"
import { installGlobals } from "./env.js"

beforeAll(installGlobals)
