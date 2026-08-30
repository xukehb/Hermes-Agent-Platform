/**
 * 出站消息分片与重投缓冲（FR-CHAN-014/015）。
 *
 * 两个职责：
 * 1) 把任意长度文本切成平台可接受的片段，切点优先落在段落 / 行 / 词边界上，
 *    代码块跨片时补齐围栏，避免手机端看到半个 fence 导致后续全部变等宽。
 * 2) 发送失败时把消息落盘到 spoolDir，进程重启后仍可重投，指令结果不会凭空消失。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { OutboundTarget } from './types.js';

/** 落盘的待重投条目。 */
export interface SpoolEntry {
  id: string;
  channel: string;
  targetId: string;
  text: string;
  queuedAt: string;
  attempts: number;
}

const FENCE = '\u0060\u0060\u0060';

/**
 * 按字符上限切分文本。
 *
 * 切点选择顺序：空行 → 换行 → 空格 → 硬切。
 * 这样绝大多数情况下不会把一句话或一个标识符劈成两半。
 */
export function splitForChannel(text: string, limit: number): string[] {
  const max = Math.max(16, limit);
  if (text.length <= max) {
    return text.length === 0 ? [] : [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.4) {
      cut = window.lastIndexOf('\n');
    }
    if (cut < max * 0.4) {
      cut = window.lastIndexOf(' ');
    }
    if (cut < max * 0.4) {
      cut = max;
    }
    const head = rest.slice(0, cut);
    chunks.push(head.trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return balanceFences(chunks);
}

/**
 * 修补被切开的代码块围栏。
 *
 * 前一片若留下奇数个围栏，则补一个收尾围栏，并给下一片开头补一个同类围栏。
 */
function balanceFences(chunks: readonly string[]): string[] {
  const output: string[] = [];
  let carry = '';
  for (const chunk of chunks) {
    const body = carry.length > 0 ? carry + '\n' + chunk : chunk;
    const fences = body.split(FENCE).length - 1;
    if (fences % 2 === 1) {
      output.push(body + '\n' + FENCE);
      carry = FENCE;
    } else {
      output.push(body);
      carry = '';
    }
  }
  return output;
}

/**
 * 出站发送器。
 *
 * send 成功返回最后一片的消息 id；任一片失败则把剩余文本整体入 spool，
 * 并把异常向上抛出，让调用方决定是否提示用户。
 */
export class OutboundSender {
  private readonly spoolDir: string;

  constructor(spoolDir: string) {
    this.spoolDir = spoolDir;
    if (!existsSync(spoolDir)) {
      mkdirSync(spoolDir, { recursive: true });
    }
  }

  /** 分片发送。limit<=0 时视为不限长度。 */
  async send(target: OutboundTarget, text: string, limit: number): Promise<string | undefined> {
    const chunks = limit > 0 ? splitForChannel(text, limit) : text.length > 0 ? [text] : [];
    let lastId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? '';
      try {
        lastId = await target.send(chunk);
      } catch (error) {
        const remaining = chunks.slice(index).join('\n\n');
        this.spool(target, remaining);
        throw error;
      }
    }
    return lastId;
  }

  /** 把发送失败的文本写入重投缓冲。 */
  spool(target: OutboundTarget, text: string): SpoolEntry {
    const entry: SpoolEntry = {
      id: randomUUID(),
      channel: target.channel,
      targetId: target.targetId,
      text,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    writeFileSync(this.file(entry.id), JSON.stringify(entry), 'utf8');
    return entry;
  }

  /** 列出全部待重投条目，按入队时间升序。 */
  list(): SpoolEntry[] {
    if (!existsSync(this.spoolDir)) {
      return [];
    }
    const entries: SpoolEntry[] = [];
    for (const name of readdirSync(this.spoolDir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        const parsed = JSON.parse(readFileSync(join(this.spoolDir, name), 'utf8')) as SpoolEntry;
        entries.push(parsed);
      } catch {
        // 损坏的缓冲文件直接删掉：重投一条脏数据没有意义，留着会永远失败
        unlinkSync(join(this.spoolDir, name));
      }
    }
    return entries.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  /**
   * 重投属于给定通道的缓冲条目。
   * resolve 负责按 targetId 还原回写目标；返回 undefined 表示该目标已不可用，条目保留。
   */
  async flush(
    channel: string,
    resolve: (targetId: string) => OutboundTarget | undefined,
    limit: number,
  ): Promise<number> {
    let sent = 0;
    for (const entry of this.list()) {
      if (entry.channel !== channel) {
        continue;
      }
      const target = resolve(entry.targetId);
      if (target === undefined) {
        continue;
      }
      try {
        await this.sendWithoutSpool(target, entry.text, limit);
        this.remove(entry.id);
        sent += 1;
      } catch {
        // 仍然失败就留在盘上，下次启动或下次 flush 再试
        this.bumpAttempts(entry);
      }
    }
    return sent;
  }

  remove(id: string): void {
    const path = this.file(id);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  private bumpAttempts(entry: SpoolEntry): void {
    const next: SpoolEntry = { ...entry, attempts: entry.attempts + 1 };
    writeFileSync(this.file(entry.id), JSON.stringify(next), 'utf8');
  }

  private async sendWithoutSpool(target: OutboundTarget, text: string, limit: number): Promise<void> {
    const chunks = limit > 0 ? splitForChannel(text, limit) : text.length > 0 ? [text] : [];
    for (const chunk of chunks) {
      await target.send(chunk);
    }
  }

  private file(id: string): string {
    return join(this.spoolDir, id + '.json');
  }
}
