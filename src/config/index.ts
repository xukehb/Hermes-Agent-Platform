/**
 * 配置层统一出口。上层模块只从这里 import，避免到处记 5 个文件名。
 *
 * 日期：2026-08-24  执行者：Codex
 */

export * from './schema.js';
export * from './resolved.js';
export * from './defaults.js';
export * from './loader.js';
export * from './resolver.js';
export * from './writer.js';
