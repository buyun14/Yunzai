import cfg from "../../lib/config/config.js"
export class quit extends plugin {
  constructor() {
    super({
      name: "notice",
      dsc: "自动退群",
      event: "notice.group.increase",
    })
  }

  async accept() {
    if (this.e.user_id != this.e.self_id || !this.e.group?.quit || !this.e.group.getMemberMap)
      return false

    const other = cfg.other
    if (!other.autoQuit) return false

    const gml = await this.e.group.getMemberMap()
    // 原文是 `if ((!gml) instanceof Map)`：对布尔值做 instanceof 恒为 false，
    // 也就是说这个守卫**从来没生效过**（已登记为 D8）。按本意改成判断 gml 本身。
    if (!(gml instanceof Map)) return false

    /** 判断主人邀请不退群 */
    for (const qq of cfg.masterQQ)
      if (gml.has(Number(qq) || String(qq))) {
        logger.mark(`[主人拉群] ${this.e.group_id}`)
        return false
      }

    /** 自动退群 */
    if (Array.from(gml).length <= other.autoQuit && !this.e.group.is_owner) {
      await this.reply("禁止拉群，已自动退出")
      logger.mark(`[自动退群] ${this.e.group_id}`)
      this.e.group.quit()
    }
  }
}
