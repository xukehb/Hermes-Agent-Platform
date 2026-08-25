/**
 * 智能体层出口。
 *
 * 通道层与 CLI 只从这里导入，不深入具体文件，
 * 这样内部文件切分调整不会波及调用方。
 *
 * 日期：2026-08-24  执行者：Codex
 */

export * from './types.js';
export * from './system-prompt.js';
export * from './router.js';
export * from './compactor.js';
export * from './loop.js';
export * from './registry.js';
export * from './subagent.js';
export * from './orchestrator.js';
