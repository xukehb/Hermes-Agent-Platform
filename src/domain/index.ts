/**
 * domain 层统一出口。其余模块一律从 'src/domain/index.js' 导入，
 * 避免深层相对路径散落各处（AGENTS.md 第 8 节「保持一致性」）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

export * from './types.js';
export * from './wire.js';
export * from './errors.js';
export * from './trace.js';
