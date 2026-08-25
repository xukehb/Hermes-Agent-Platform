/**
 * 工具集裁剪（FR-TOOL-003）。
 *
 * 与 config/resolver.ts 的 expandToolSelection 的分工：
 * 后者只处理内置工具名的档位展开，用于配置层解释；
 * 本文件面向运行时的真实注册表，额外承担两件事：
 * 1. MCP 工具默认随配置生效——用户既然在 [mcp_servers.*] 里声明了服务器，
 *    就视为对全部智能体开放，除非用 allow 显式收窄或用 deny 排除；
 * 2. allow / deny 支持 * 通配符，否则动辄几十个工具的 MCP 服务器无法书写。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { TOOL_PROFILES } from '../config/defaults.js';
import type { ToolProfileName } from '../config/resolved.js';
import type { ToolDefinition } from '../domain/index.js';

export interface ToolSelection {
  profile: ToolProfileName;
  allow: readonly string[];
  deny: readonly string[];
}

const REGEXP_SPECIAL = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

function escapeRegExp(text: string): string {
  let out = '';
  for (const ch of text) {
    if (REGEXP_SPECIAL.has(ch)) out += '\\';
    out += ch;
  }
  return out;
}

/** 工具名模式匹配，仅支持 * 通配符（如 filesystem__*）。 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const body = pattern.split('*').map((part) => escapeRegExp(part)).join('.*');
  return new RegExp('^' + body + '$').test(name);
}

function matchesAny(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => matchesToolPattern(pattern, name));
}

/**
 * 计算智能体最终可用的工具名清单。
 * available 为注册表当前全部工具声明，顺序即注入顺序。
 */
export function selectToolNames(selection: ToolSelection, available: readonly ToolDefinition[]): string[] {
  const byName = new Map<string, ToolDefinition>();
  for (const definition of available) byName.set(definition.name, definition);

  const candidates: string[] = [];
  if (selection.allow.length > 0) {
    for (const definition of available) {
      if (matchesAny(selection.allow, definition.name)) candidates.push(definition.name);
    }
  } else {
    for (const name of TOOL_PROFILES[selection.profile]) {
      if (byName.has(name)) candidates.push(name);
    }
    for (const definition of available) {
      if (definition.source !== 'builtin' && !candidates.includes(definition.name)) candidates.push(definition.name);
    }
  }

  const result: string[] = [];
  for (const name of candidates) {
    if (matchesAny(selection.deny, name)) continue;
    if (!result.includes(name)) result.push(name);
  }
  return result;
}
