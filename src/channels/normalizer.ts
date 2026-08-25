/**
 * 任务事件 → 用户可见文本的渲染器（FR-CHAN-005/006/007）。
 *
 * 手机端屏幕小，事件流必须收敛成「一屏能读完」的进度视图：
 * 工具调用只留最近若干条、推理段按配置开关、模型降级必须显式提示。
 * 渲染器只做字符串拼装，不碰网络，因此可以脱离 Telegram 单测。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { TaskEvent } from '../agent/index.js';

/** 渲染器配置。 */
export interface RenderOptions {
  /** 智能体身份前缀，如 🛠 coder */
  header: string;
  /** 是否展示 reasoning 段（FR-LOOP-014） */
  reasoningVisible: boolean;
  /** 进度视图里保留的工具行数 */
  toolTailSize?: number;
  /** 正文预览的字符上限，超出则从尾部截断 */
  previewLimit?: number;
}

const DEFAULT_TOOL_TAIL = 4;
const DEFAULT_PREVIEW_LIMIT = 2400;

/**
 * 事件累积器。
 *
 * 同一实例对应一次任务：通道每收到事件就 push，然后取 progress() 去刷新那条消息。
 */
export class TaskRenderer {
  private readonly options: Required<RenderOptions>;
  private readonly toolLines: string[] = [];
  private readonly notices: string[] = [];
  private readonly switches: string[] = [];
  private text = '';
  private reasoning = '';
  private iteration = 0;
  private activeTool: string | undefined;
  private dirty = true;
  private cached = '';

  constructor(options: RenderOptions) {
    this.options = {
      header: options.header,
      reasoningVisible: options.reasoningVisible,
      toolTailSize: options.toolTailSize ?? DEFAULT_TOOL_TAIL,
      previewLimit: options.previewLimit ?? DEFAULT_PREVIEW_LIMIT,
    };
  }

  /** 累积一条事件。返回是否产生了可见变化，用于跳过无意义的编辑请求。 */
  push(event: TaskEvent): boolean {
    switch (event.type) {
      case 'iteration':
        this.iteration = event.index;
        break;
      case 'text':
        this.text += event.text;
        break;
      case 'reasoning':
        this.reasoning += event.text;
        break;
      case 'tool_start':
        this.activeTool = event.name;
        this.toolLines.push('⏳ ' + event.name + ' ' + summarizeArgs(event.args));
        break;
      case 'tool_end': {
        const mark = event.result.isError === true ? '✗' : '✓';
        const last = this.toolLines.length - 1;
        const line = this.toolLines[last];
        if (line !== undefined && line.startsWith('⏳ ')) {
          this.toolLines[last] = mark + ' ' + line.slice(2).trim() + durationSuffix(event.result.durationMs);
        } else {
          this.toolLines.push(mark + ' ' + (this.activeTool ?? 'tool'));
        }
        this.activeTool = undefined;
        break;
      }
      case 'model_switch':
        this.switches.push('↻ ' + event.from + ' → ' + event.to + '（' + event.reason + '）');
        break;
      case 'notice':
        this.notices.push('⚠ ' + event.message);
        break;
      case 'usage':
        // 用量只在终态展示，进度视图里刷新它会让消息抖动
        return false;
      default:
        return false;
    }
    this.dirty = true;
    return true;
  }

  /** 是否有未渲染的变化。 */
  get hasChanges(): boolean {
    return this.dirty;
  }

  /** 已累积的正文。 */
  get body(): string {
    return this.text;
  }

  /** 进度视图：头部 + 降级提示 + 工具尾巴 + 正文预览。 */
  progress(): string {
    if (!this.dirty) {
      return this.cached;
    }
    const lines: string[] = [this.options.header + '  ·  第 ' + String(Math.max(1, this.iteration)) + ' 轮'];
    for (const item of this.switches) {
      lines.push(item);
    }
    for (const item of this.notices) {
      lines.push(item);
    }
    const tail = this.toolLines.slice(-this.options.toolTailSize);
    if (this.toolLines.length > tail.length) {
      lines.push('… 已省略 ' + String(this.toolLines.length - tail.length) + ' 条工具调用');
    }
    for (const item of tail) {
      lines.push(item);
    }
    if (this.options.reasoningVisible && this.reasoning.trim().length > 0) {
      lines.push('');
      lines.push('🧠 ' + clampTail(this.reasoning.trim(), 400));
    }
    const preview = clampTail(this.text.trim(), this.options.previewLimit);
    if (preview.length > 0) {
      lines.push('');
      lines.push(preview);
    }
    this.cached = lines.join('\n');
    this.dirty = false;
    return this.cached;
  }

  /** 终态视图：正文 + 受限收尾提示。terminalNote 由通道按 stopReason 生成。 */
  final(terminalNote?: string): string {
    const lines: string[] = [];
    if (this.options.reasoningVisible && this.reasoning.trim().length > 0) {
      lines.push('🧠 ' + this.reasoning.trim());
      lines.push('');
    }
    const body = this.text.trim();
    lines.push(body.length > 0 ? body : '（本次没有产生正文输出）');
    for (const item of this.switches) {
      lines.push('');
      lines.push(item);
    }
    if (terminalNote !== undefined && terminalNote.length > 0) {
      lines.push('');
      lines.push(terminalNote);
    }
    return lines.join('\n');
  }
}

/** 工具入参摘要：只取前两个键，值过长则截断。 */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args).slice(0, 2)) {
    parts.push(key + '=' + clampTail(stringifyArg(value), 48));
  }
  return parts.length === 0 ? '' : '(' + parts.join(', ') + ')';
}

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function durationSuffix(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return '';
  }
  return durationMs >= 1000 ? '  ' + (durationMs / 1000).toFixed(1) + 's' : '  ' + String(durationMs) + 'ms';
}

/** 从尾部保留 limit 个字符，前面用省略号标记。 */
function clampTail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return '…' + text.slice(text.length - limit + 1);
}
