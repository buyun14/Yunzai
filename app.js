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
