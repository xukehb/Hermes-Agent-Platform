/**
 * 内置工具集合（FR-TOOL-001）。
 *
 * 数组顺序与 config/defaults.ts 的 BUILTIN_TOOL_NAMES 一致，
 * 因为该顺序同时决定 hermes-native 协议 <tools> 段的展示顺序。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ToolModule } from '../types.js';
import { applyPatchTool } from './apply-patch.js';
import { listDirTool, readFileTool, writeFileTool } from './files.js';
import { httpFetchTool } from './http-fetch.js';
import { openExternalTool } from './open-external.js';
import { searchTool } from './search.js';
import { shellTool } from './shell.js';
import { spawnSubagentTool } from './spawn-subagent.js';
import { remoteExecTool, remoteSysinfoTool, remoteListServersTool, remoteUpgradeDaemonTool } from './remote-tools.js';
import { findDefinitionTool, findReferencesTool, listSymbolsTool } from './symbol-tools.js';
import { hostSysinfoTool } from './host-tools.js';
import { diskCleanupTool, ipLookupTool } from './cleanup-tools.js';
import { generateImageTool } from './image-tools.js';
import { webSearchTool } from './web-search.js';

export const BUILTIN_TOOL_MODULES: readonly ToolModule[] = [
  shellTool,
  openExternalTool,
  readFileTool,
  writeFileTool,
  applyPatchTool,
  listDirTool,
  searchTool,
  httpFetchTool,
  spawnSubagentTool,
  remoteExecTool,
  remoteSysinfoTool,
  remoteListServersTool,
  remoteUpgradeDaemonTool,
  findDefinitionTool,
  findReferencesTool,
  listSymbolsTool,
  hostSysinfoTool,
  diskCleanupTool,
  ipLookupTool,
  generateImageTool,
  webSearchTool,
];

/** 返回内置工具的新数组，避免调用方改动共享常量。 */
export function builtinTools(): ToolModule[] {
  return [...BUILTIN_TOOL_MODULES];
}

export {
  applyPatchTool,
  listDirTool,
  openExternalTool,
  readFileTool,
  writeFileTool,
  httpFetchTool,
  searchTool,
  shellTool,
  spawnSubagentTool,
  remoteExecTool,
  remoteSysinfoTool,
  remoteListServersTool,
  remoteUpgradeDaemonTool,
  findDefinitionTool,
  findReferencesTool,
  listSymbolsTool,
  hostSysinfoTool,
  diskCleanupTool,
  ipLookupTool,
  generateImageTool,
  webSearchTool,
};
export { applyHunks, parsePatch } from './patch-envelope.js';
export type { PatchHunk, PatchLine, PatchOperation } from './patch-envelope.js';
