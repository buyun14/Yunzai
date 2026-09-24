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
Bot.run()

// 仅为一件事而存在：本文件用了顶层 await，但自身没有任何 import / export，
// 于是 TypeScript 把它当作**脚本**而不是模块，报 4 处 TS1375
// （"'await' expressions are only allowed at the top level of a file when
// that file is a module"）。加一个空导出即可声明"这是模块"。
// 运行期无任何影响：package.json 声明了 "type": "module"，它本来就是 ES 模块。
export {}
