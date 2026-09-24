#!/usr/bin/env node
/**
 * 启动冒烟：真的把整个进程拉起来一次，跑到"插件加载完成"，再让它优雅退出。
 *
 * 为什么单测不够
 * --------------
 * 单测逐个 import 模块，跑的是纯函数与流水线阶段；`lint` 与 `typecheck` 也不执行
 * 顶层代码。于是「某插件 import 了一个不存在的包」「两个模块循环依赖」「某个全局
 * 变量在使用前还没注入」这一类问题，三种闸门都抓不到，只有真正 `node .` 启动一次
 * 才会暴露——这正是本脚本存在的理由。
 *
 * 为什么不能用退出码当判据
 * ------------------------
 * `node . stop` → `app.js` 的 stop 分支 → `Bot.serverExit()` → `Bot.exit(1)`，
 * 也就是「优雅停止」与「崩溃」的退出码都是 1，无法区分。判据因此只能是日志：
 * 必须看到 `加载插件[N个]`，且 N > 0。
 *
 * 已知局限（写清楚，免得误以为它覆盖得比实际多）
 * ----------------------------------------------
 * 它只回答"能不能起来"，不回答"起来之后行为对不对"——后者归单测与金标准对比。
 * 适配器连不上平台时打的 `[ERRO]` 属正常现象，所以这里只统计并打印，不作失败
 * 判据；判失败的是三类"起来了但坏了"的信号：模块解析失败 / 插件加载超时 /
 * 未捕获异常。取舍理由是：一个长期因环境而红的冒烟，等价于没有冒烟。
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)))
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180000)
const STOP_GRACE_MS = 20000

/** 插件加载完成的标志行，同时在括号里捕获加载数量 */
const LOADED_RE = /加载插件\[(\d+)个\]/
const ERROR_LINE_RE = /\[ERRO\]/

/** "起来了但坏了"的信号：出现即失败 */
const FATAL_SIGNALS = [
  ["模块解析失败", /Cannot find package|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/],
  ["插件加载超时", /插件加载超时/],
  ["未捕获异常", /UnhandledPromiseRejection|uncaughtException/i],
]

/**
 * 读出生效的服务器端口。
 *
 * 只做极简的行匹配、不引入 YAML 解析：这里唯一目的是"启动前确认端口是空的"。
 * 之所以必须先确认——`Bot.serverEADDRINUSE()` 会向该端口发一个 /exit 请求去挤掉
 * 占用者。如果本地正跑着一个机器人实例，本脚本会把它关掉。宁可提前退出。
 */
function readServerPort() {
  for (const rel of ["config/config/server.yaml", "config/default_config/server.yaml"]) {
    try {
      const matched = readFileSync(path.join(root, rel), "utf8").match(/^\s*port:\s*(\d+)/m)
      if (matched) return Number(matched[1])
    } catch {
      // 配置文件缺失时继续尝试下一个；两个都没有则用默认值
    }
  }
  return 2536
}

/** 探测端口是否能被独占监听 */
function isPortFree(port) {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

/** 输出末尾若干行，用于失败时定位 */
function tail(text, lines = 40) {
  const all = text.split(/\r?\n/).filter(Boolean)
  return all.slice(-lines).join("\n")
}

const port = readServerPort()
if (!(await isPortFree(port))) {
  console.error(`[smoke] 端口 ${port} 已被占用，拒绝继续。`)
  console.error("[smoke] 原因：Bot 遇到端口冲突时会向该端口发 /exit 请求挤掉占用者，")
  console.error("[smoke] 若那是正在运行的机器人实例，它会被本脚本一并关掉。")
  process.exit(1)
}

console.log(`[smoke] 启动：${process.execPath} .（cwd=${root}）`)
const child = spawn(process.execPath, ["."], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })

/** 子进程输出既实时透传（CI 日志里能直接看），也累积下来供断言与失败定位 */
let output = ""
const capture = chunk => {
  const text = chunk.toString()
  output += text
  return text
}
child.stdout.on("data", chunk => process.stdout.write(capture(chunk)))
child.stderr.on("data", chunk => process.stderr.write(capture(chunk)))

/**
 * 失败时收尾：打印输出尾部与原因，杀掉子进程，然后以非零码退出。
 *
 * 不重复打印完整输出——它已经实时透传在上面了；重复一遍只会让 CI 日志翻倍，
 * 而真正需要的是"最后发生了什么"。
 */
function abort(reason) {
  console.error(`\n[smoke] 失败：${reason}`)
  console.error("[smoke] ----- 输出末尾 -----")
  console.error(tail(output))
  child.kill()
  process.exit(1)
}

/** 等「插件加载完成」/「进程提前退出」/「超时」三者之一 */
const started = await new Promise(resolve => {
  const timer = setTimeout(
    () => resolve({ ok: false, why: `等待 ${TIMEOUT_MS}ms 仍未出现"加载插件[N个]"` }),
    TIMEOUT_MS,
  )
  const finish = result => {
    clearTimeout(timer)
    resolve(result)
  }
  child.stdout.on("data", () => {
    const loaded = output.match(LOADED_RE)
    if (loaded) finish({ ok: true, count: Number(loaded[1]) })
  })
  child.once("error", err => finish({ ok: false, why: `无法启动子进程：${err.message}` }))
  child.once("exit", code => finish({ ok: false, why: `进程在插件加载完成前退出（code=${code}）` }))
})

if (!started.ok) abort(started.why)
if (!(started.count > 0)) abort(`插件加载数为 ${started.count}，不满足 > 0`)
for (const [name, re] of FATAL_SIGNALS)
  if (re.test(output)) abort(`启动输出中出现${name}：${output.match(re)[0]}`)

// 走到这里说明"起来了"。接着验证它能不能干净地停下——只起不停会让 CI 挂到超时。
spawn(process.execPath, [".", "stop"], { cwd: root, stdio: "ignore" })
const stopped = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ ok: false }), STOP_GRACE_MS)
  child.once("exit", code => {
    clearTimeout(timer)
    resolve({ ok: true, code })
  })
})

if (!stopped.ok) abort(`发送 stop 后 ${STOP_GRACE_MS}ms 内进程没有退出`)

const errorLines = output.split(/\r?\n/).filter(line => ERROR_LINE_RE.test(line))

console.log("")
console.log(`[smoke] 通过：加载插件 ${started.count} 个，进程已退出（code=${stopped.code}）`)
console.log(`[smoke] 输出中 [ERRO] 行 ${errorLines.length} 条（仅统计，不作失败判据）`)
for (const line of errorLines.slice(0, 10)) console.log(`[smoke]   ${line.trim()}`)

process.exit(0)
