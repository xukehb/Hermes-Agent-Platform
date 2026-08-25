/**
 * http_fetch 工具：抓取网页或调用 HTTP 接口（FR-TOOL-001）。
 *
 * 直接使用 Node 内置 fetch，不引入 http 客户端依赖。按硬约束，
 * 本工具不做任何目标地址过滤或凭据脱敏之类的安全性处理。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { z } from 'zod';
import { RecoverableError, describeError } from '../../domain/index.js';
import { defineTool } from '../define.js';

/** 工具自身的正文上限；ToolExecutor 还会按 limits.tool_output_max_bytes 二次裁剪。 */
const DEFAULT_MAX_CHARS = 120000;

export const httpFetchTool = defineTool({
  name: 'http_fetch',
  description: '发起 HTTP 请求并返回状态码、关键响应头与正文文本。用于查资料或调用外部接口。',
  schema: z.object({
    url: z.string().min(1).describe('完整 URL，含 http/https 协议'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional().describe('缺省 GET'),
    headers: z.record(z.string(), z.string()).optional().describe('额外请求头'),
    body: z.string().optional().describe('请求正文，POST/PUT/PATCH 时使用'),
    max_chars: z.number().int().positive().optional().describe('正文截断字符数，缺省 120000'),
  }),
  run: async (args, ctx) => {
    const init: RequestInit = { method: args.method ?? 'GET', signal: ctx.signal, redirect: 'follow' };
    if (args.headers !== undefined) init.headers = args.headers;
    if (args.body !== undefined) init.body = args.body;

    let response: Response;
    try {
      response = await fetch(args.url, init);
    } catch (error) {
      throw new RecoverableError('TOOL_FAILED', 'HTTP 请求失败：' + args.url + ' —— ' + describeError(error), {
        context: { url: args.url },
      });
    }

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      text = '（正文读取失败：' + describeError(error) + '）';
    }
    const limit = args.max_chars ?? DEFAULT_MAX_CHARS;
    const clipped = text.length > limit ? text.slice(0, limit) + '\n…（正文已截断，原长 ' + text.length + ' 字符）' : text;
    const contentType = response.headers.get('content-type') ?? '未声明';
    const header = 'HTTP ' + response.status + ' ' + response.statusText + '\ncontent-type: ' + contentType + '\nurl: ' + response.url;
    return { content: header + '\n\n' + clipped, isError: !response.ok };
  },
});
