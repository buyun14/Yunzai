/**
 * 打印一段文本并退出（CLI 分支共用）。
 *
 * 必须**等 stdout 写完**再退：管道下 stdout 是异步的，写完之前 `exit` 会把长输出
 * 截断。反过来，光用 `write(text, () => process.exit())` 也不行——回调是异步的，
 * 而 `break` 之后控制流会继续走到本文件底部的 `new Bot()`，于是“只读命令”
 * 会顺手把整个 bot 启动起来（甚至因为端口被占用去挤掉运行中的实例）。
 * `await` 是唯一能同时满足两者的写法。
 *
 * @param {string} text 要输出的文本
 * @param {number} [code] 退出码
 * @returns {Promise<void>}
 */
async function printAndExit(text, code = 0) {
  await new Promise(resolve => process.stdout.write(`${text}\n`, resolve))
  process.exit(code)
}

switch (process.env.app_type || process.argv[2]) {
  case "stop": {
    const cfg = (await import("./lib/config/config.js")).default
    await fetch(`http://localhost:${cfg.server.port}/exit`, {
      headers: cfg.server.auth || undefined,
    }).catch(() => {})
    process.exit()
    // process.exit() 不返回，这个 break 不会执行；写上是为了标明分支意图，
    // 也让 no-fallthrough 不必依赖“注释例外”才能通过。
    break
  }
  case "daemon": {
    console.log("守护进程正在启动主进程")
    const { spawnSync } = await import("node:child_process")
    while (
      spawnSync(process.argv[0], [process.argv[1], "start", ...process.argv.slice(2)], {
        stdio: "inherit",
      }).status !== 255
    )
      console.log("守护进程正在重启主进程")
    console.log("守护进程已停止")
    process.exit()
    // 同上：process.exit() 不返回
    break
  }
  case "config:diff": {
    // 只读命令。三个刻意的选择：
    //
    // 1. **不导入** lib/config/config.js——它的构造函数会跑 initCfg()，
    //    那会往用户的 config/config/ 里复制文件。一个叫"差异报告"的命令
    //    顺手改用户的配置，是最不该有的意外。所以这里只依赖 diff.js 自己。
    // 2. 要等 stdout 写完再退：管道下 stdout 是异步的，写完之前 exit
    //    会把长输出截断（--all 时很容易碰到）。
    // 3. 但"等写完"不能靠传回调——回调是异步的，而 `break` 之后控制流会直接
    //    走到下面的 `new Bot()`，于是这个"只读报告"会顺手把整个 bot 启动起来。
    //    实测撞上过：它还因为端口被占用，向运行中的实例发了 /exit 把它挤掉。
    //    所以用 await 等写入完成，**同步地**把进程结束在 switch 里。
    const { collectDiff, formatDiff } = await import("./lib/config/diff.js")
    const text = formatDiff(await collectDiff(), {
      limit: process.argv.includes("--all") ? Infinity : 20,
    })
    await printAndExit(text)
    // 同上：process.exit() 不返回
    break
  }
  case "backup": {
    // `node . backup [--out <path>]`：打一个可携带的逻辑包（阶段 5 §3.4）。
    // 它不启动 bot、不碰 redis：只读项目目录，只写 --out 指定的那一个文件。
    const { buildArchive, writeArchive } = await import("./lib/config/archive.js")
    const { stampOf } = await import("./lib/config/backup.js")

    const outIndex = process.argv.indexOf("--out")
    const out = outIndex === -1 ? `backup-${stampOf()}.zip` : process.argv[outIndex + 1]
    if (!out) await printAndExit("--out 后面要跟一个文件路径", 2)

    const { manifest, buffer } = await buildArchive()
    await writeArchive(out, buffer)

    await printAndExit(
      [
        `已生成备份包：${out}`,
        `  条目 ${manifest.entries.length} 个、插件 ${manifest.plugins} 个、配置版本 v${manifest.config_version ?? "未知"}`,
        `  范围：${manifest.scope.join("、")}（不含 node_modules / temp / logs / redis）`,
        "",
        "这个包可以用系统自带工具解开查看，也可以用 node . restore <包> 还原。",
      ].join("\n"),
    )
    // 同上：process.exit() 不返回
    break
  }
  case "restore": {
    // `node . restore <包>`：校验 manifest → 先给当前状态打一个包 → 解包 → 跑迁移。
    // 迁移按**包里记录的** config_version 补跑：包可能是旧版本导出的，直接丢回
    // 项目里等于把配置降级，迁移是唯一能把两者对齐的东西。
    const { restoreArchive } = await import("./lib/config/archive.js")
    const file = process.argv[3]
    if (!file) await printAndExit("用法：node . restore <备份包路径>", 2)

    const { manifest, restored, previous, migration } = await restoreArchive(file)

    await printAndExit(
      [
        `已从 ${file} 恢复 ${restored} 个文件`,
        `  包里记录的版本：yunzai ${manifest.yunzai_version ?? "未知"} / 配置 v${manifest.config_version ?? "未知"} / 导出时间 ${manifest.created_at}`,
        `  恢复前的当前状态已存到：${previous}`,
        migration && migration.applied.length
          ? `  配置迁移：v${migration.from} → v${migration.to}（${migration.applied.length} 个脚本）`
          : "  配置迁移：无需执行",
        "",
        "恢复是覆盖语义（不会删除包里没有的文件）。请重启 bot 让它生效。",
      ].join("\n"),
    )
    // 同上：process.exit() 不返回
    break
  }
  case "pm2":
    global.start_type = "pm2"
    break
  case "start":
    global.start_type = "external"
    break
  default:
    global.start_type = "internal"
}
global.Bot = new (await import("./lib/bot.js")).default()

/**
 * 配置迁移（阶段 5 §3.1）。
 *
 * 位置是刻意的：`lib/bot.js` 导入 `lib/config/config.js` 时已经跑过 `initCfg()`
 * （把 `default_config/` 里缺的文件补进 `config/config/`），而插件要等 `Bot.run()`
 * 才加载。夹在中间，迁完就能被配置读取与插件看到。
 *
 * 失败即 `process.exit(1)`：`migrate.js` 已经把“备份在哪、怎么退回去”写进错误消息了，
 * 这里只负责如实打印并停住——半迁移状态继续启动，比开不起来危险得多。
 * 已是最新时 `runMigrations()` 什么都不做（不备份不写文件），所以每次启动都调是安全的。
 */
try {
  const { runMigrations } = await import("./lib/config/migrate.js")
  const { from, to, applied, backup } = await runMigrations()

  if (applied.length) {
    logger.mark(`配置已从 v${from} 迁移到 v${to}，共 ${applied.length} 个脚本`)
    for (const item of applied) logger.mark(`  · ${item}`)
    logger.mark(`迁移前备份：${backup}`)
  }
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

Bot.run()

// 仅为一件事而存在：本文件用了顶层 await，但自身没有任何 import / export，
// 于是 TypeScript 把它当作**脚本**而不是模块，报 4 处 TS1375
// （"'await' expressions are only allowed at the top level of a file when
// that file is a module"）。加一个空导出即可声明"这是模块"。
// 运行期无任何影响：package.json 声明了 "type": "module"，它本来就是 ES 模块。
export {}
