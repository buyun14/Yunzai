import EventListener from "../listener/listener.js"

/**
 * 监听上线事件
 */
export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: "online",
      once: true,
    })
  }

  async execute() {
    // 上线标记。原来这里打的是框架作者的装饰性颜文字 `----^_^----`，
    // 换成一句有实际信息的话：它在日志里既是分界点，也顺便说明"可以收消息了"
    logger.mark("适配器已上线，开始处理消息")
  }
}
