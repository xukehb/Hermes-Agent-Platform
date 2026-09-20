/**
 * `i18n-source-en.js` 由 tools/i18n/generate-source-dict.mjs 生成，
 * 是一个没有模块导出的副作用脚本，只在执行时把词典挂到 globalThis 上。
 * 这里补充类型声明，避免测试里 import 该 .js 时触发 TS7016。
 */
export {};

declare global {
  /** 中文原文 -> 英文译文 的精确词典 */
  var HAP_SOURCE_TEXT_EN: Record<string, string>;
  /** 含 `${expr}` 插值的模板规则： [匹配正则, 替换模板] */
  var HAP_SOURCE_TEXT_PATTERNS: [RegExp, string][];
}
