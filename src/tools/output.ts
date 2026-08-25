/**
 * 工具输出裁剪与溢出落盘（FR-TOOL-007）。
 *
 * 规则：超过 tool_output_max_bytes 时保留首尾片段，中间以中文标注省略字节数，
 * 完整输出写入 overflowDir 供 read_file 按需回读，路径回填到 ToolResult.overflowPath。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TruncateOptions {
  maxBytes: number;
  overflowDir: string;
  taskId: string;
  callId: string;
  toolName: string;
}

export interface TruncatedOutput {
  content: string;
  truncated: boolean;
  overflowPath?: string;
}

/** 文件名去除路径分隔符与不可见字符，避免 callId 里的奇怪字符破坏路径。 */
function sanitizeSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unnamed';
}

function buildMarker(omitted: number, total: number, overflowPath: string | undefined): string {
  const tail = overflowPath === undefined ? '' : '，完整内容见 ' + overflowPath;
  return '\n\n…（已省略中间 ' + omitted + ' 字节，原始输出共 ' + total + ' 字节' + tail + '）…\n\n';
}

/** 把完整输出写入溢出目录；写盘失败不影响主流程，仅退化为无 overflowPath。 */
async function spillOverflow(raw: string, options: TruncateOptions): Promise<string | undefined> {
  try {
    const dir = path.join(options.overflowDir, sanitizeSegment(options.taskId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, sanitizeSegment(options.toolName) + '-' + sanitizeSegment(options.callId) + '.txt');
    await writeFile(file, raw, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * 按字节预算裁剪工具输出。
 * 首尾比例 6:4，标记本身也计入预算，故用收缩循环保证最终字节数不超上限。
 */
export async function truncateToolOutput(raw: string, options: TruncateOptions): Promise<TruncatedOutput> {
  const total = Buffer.byteLength(raw, 'utf8');
  const max = Math.max(512, options.maxBytes);
  if (total <= max) return { content: raw, truncated: false };

  const overflowPath = await spillOverflow(raw, options);
  let budget = max;
  let content = '';
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const headChars = Math.floor(budget * 0.6);
    const tailChars = Math.max(0, budget - headChars);
    const head = raw.slice(0, headChars);
    const tail = tailChars > 0 ? raw.slice(raw.length - tailChars) : '';
    const omitted = Math.max(0, total - Buffer.byteLength(head + tail, 'utf8'));
    content = head + buildMarker(omitted, total, overflowPath) + tail;
    if (Buffer.byteLength(content, 'utf8') <= max) break;
    budget = Math.floor(budget * 0.85);
    if (budget < 128) break;
  }

  const result: TruncatedOutput = { content, truncated: true };
  if (overflowPath !== undefined) result.overflowPath = overflowPath;
  return result;
}
