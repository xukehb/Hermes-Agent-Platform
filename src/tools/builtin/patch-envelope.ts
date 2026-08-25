/**
 * apply_patch 信封的解析与应用（FR-TOOL-001）。
 *
 * 采用与 Codex / OpenAI apply_patch 一致的信封格式，理由：这是当前智能体生态里
 * 事实标准的「模型友好」补丁格式——不依赖行号、以上下文行定位，模型出错率远低于 unified diff。
 * 本文件保持纯函数（不碰文件系统），便于单元测试逐条覆盖。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { RecoverableError } from '../../domain/index.js';

export type PatchLineOp = ' ' | '-' | '+';

export interface PatchLine {
  op: PatchLineOp;
  text: string;
}

export interface PatchHunk {
  /** @@ 后面的定位标记，可为空 */
  marker: string;
  lines: PatchLine[];
}

export type PatchOperation =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: PatchHunk[] };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';

function invalid(message: string): RecoverableError {
  return new RecoverableError('TOOL_INVALID_ARGS', message);
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** 解析补丁信封。语法错误一律以 TOOL_INVALID_ARGS 抛出，供 executor 回灌给模型自纠。 */
export function parsePatch(text: string): PatchOperation[] {
  const lines = splitLines(text);
  let index = 0;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  if ((lines[index] ?? '').trim() !== BEGIN) {
    throw invalid('补丁必须以 ' + BEGIN + ' 开头，以 ' + END + ' 结尾。');
  }
  index += 1;

  const operations: PatchOperation[] = [];
  let current: PatchOperation | undefined;
  let currentHunk: PatchHunk | undefined;
  let sawEnd = false;

  const closeHunk = (): void => {
    if (current !== undefined && current.kind === 'update' && currentHunk !== undefined && currentHunk.lines.length > 0) {
      current.hunks.push(currentHunk);
    }
    currentHunk = undefined;
  };
  const closeOperation = (): void => {
    closeHunk();
    if (current !== undefined) operations.push(current);
    current = undefined;
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed === END) {
      sawEnd = true;
      break;
    }
    if (line.startsWith(ADD)) {
      closeOperation();
      current = { kind: 'add', path: line.slice(ADD.length).trim(), content: '' };
      continue;
    }
    if (line.startsWith(DELETE)) {
      closeOperation();
      operations.push({ kind: 'delete', path: line.slice(DELETE.length).trim() });
      continue;
    }
    if (line.startsWith(UPDATE)) {
      closeOperation();
      current = { kind: 'update', path: line.slice(UPDATE.length).trim(), hunks: [] };
      continue;
    }
    if (line.startsWith(MOVE)) {
      if (current === undefined || current.kind !== 'update') {
        throw invalid(MOVE.trim() + ' 只能紧跟在 ' + UPDATE.trim() + ' 之后。');
      }
      current.moveTo = line.slice(MOVE.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === undefined || current.kind !== 'update') {
        throw invalid('@@ 区块只能出现在 ' + UPDATE.trim() + ' 之后。');
      }
      closeHunk();
      currentHunk = { marker: line.slice(2).trim(), lines: [] };
      continue;
    }
    if (current === undefined) {
      if (trimmed === '') continue;
      throw invalid('补丁正文出现在任何文件指令之前：' + line);
    }
    if (current.kind === 'add') {
      if (!line.startsWith('+')) {
        if (trimmed === '') continue;
        throw invalid(ADD.trim() + ' 区块的每一行都必须以 + 开头，实际为：' + line);
      }
      current.content = current.content === '' ? line.slice(1) : current.content + '\n' + line.slice(1);
      continue;
    }
    if (currentHunk === undefined) currentHunk = { marker: '', lines: [] };
    if (line.startsWith('+')) currentHunk.lines.push({ op: '+', text: line.slice(1) });
    else if (line.startsWith('-')) currentHunk.lines.push({ op: '-', text: line.slice(1) });
    else if (line.startsWith(' ')) currentHunk.lines.push({ op: ' ', text: line.slice(1) });
    else currentHunk.lines.push({ op: ' ', text: line });
  }

  if (!sawEnd) throw invalid('补丁缺少结尾标记 ' + END + '。');
  closeOperation();
  if (operations.length === 0) throw invalid('补丁中没有任何文件操作。');
  return operations;
}

function sameSequence(lines: readonly string[], sequence: readonly string[], start: number, loose: boolean): boolean {
  for (let offset = 0; offset < sequence.length; offset += 1) {
    const actual = lines[start + offset];
    const expected = sequence[offset] ?? '';
    if (actual === undefined) return false;
    if (loose ? actual.trim() !== expected.trim() : actual !== expected) return false;
  }
  return true;
}

/** 在文件行数组中定位一段序列，先精确匹配再退化为忽略首尾空白的匹配。 */
function locateSequence(lines: readonly string[], sequence: readonly string[], from: number): number {
  if (sequence.length === 0) return from;
  for (const loose of [false, true]) {
    for (let start = from; start + sequence.length <= lines.length; start += 1) {
      if (sameSequence(lines, sequence, start, loose)) return start;
    }
    if (from > 0) {
      for (let start = 0; start + sequence.length <= lines.length && start < from; start += 1) {
        if (sameSequence(lines, sequence, start, loose)) return start;
      }
    }
  }
  return -1;
}

/** 按 @@ 标记把游标推进到候选位置附近，标记缺失或未命中时返回原游标。 */
function locateMarker(lines: readonly string[], marker: string, from: number): number {
  if (marker === '') return from;
  const needle = marker.trim();
  for (let start = from; start < lines.length; start += 1) {
    const line = lines[start] ?? '';
    if (line.trim() === needle || line.includes(needle)) return start;
  }
  for (let start = 0; start < from; start += 1) {
    const line = lines[start] ?? '';
    if (line.trim() === needle || line.includes(needle)) return start;
  }
  return from;
}

export interface HunkStats {
  added: number;
  removed: number;
}

export interface ApplyResult {
  text: string;
  stats: HunkStats;
}

/** 把一组 hunk 应用到文件文本上。定位失败抛 TOOL_FAILED，附带失败的上下文行。 */
export function applyHunks(original: string, hunks: readonly PatchHunk[], label: string): ApplyResult {
  const lines = splitLines(original);
  let cursor = 0;
  let added = 0;
  let removed = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.op !== '+').map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.op !== '-').map((line) => line.text);
    const searchFrom = locateMarker(lines, hunk.marker, cursor);
    const at = locateSequence(lines, oldLines, searchFrom);
    if (at < 0) {
      const sample = oldLines.length > 0 ? oldLines[0] : hunk.marker;
      throw new RecoverableError(
        'TOOL_FAILED',
        '补丁无法应用到 ' + label + '：未找到上下文「' + (sample ?? '') + '」。请先用 read_file 读取当前内容再重试。',
        { context: { path: label, marker: hunk.marker } },
      );
    }
    lines.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
    added += hunk.lines.filter((line) => line.op === '+').length;
    removed += hunk.lines.filter((line) => line.op === '-').length;
  }

  return { text: lines.join('\n'), stats: { added, removed } };
}
