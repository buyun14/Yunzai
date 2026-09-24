export default {
  semi: false,
  printWidth: 100,
  arrowParens: "avoid",
  /**
   * 保留文件既有的行尾。
   *
   * 原因：本机 git 配置 `core.autocrlf=true`，检出到工作区的文件是 CRLF，
   * 而 prettier 默认 `endOfLine: "lf"` 会把所有文件判为格式不符（假阳性）。
   * 设为 "auto" 后校验只关心格式化结果、不关心行尾，Windows 与 Linux 结果一致。
   *
   * 根因治理（新增 .gitattributes 并把工作区统一为 LF）已记录在
   * docs/refactor/00-prep.md，需要单独一次工作区重新检出，不在阶段 0 处理。
   */
  endOfLine: "auto",
}
