/**
 * http_fetch 工具：抓取网页或调用 HTTP 接口（FR-TOOL-001）。
 *
 * 使用绑定到已验证 DNS 地址的 Node HTTP 客户端，避免请求在校验后
 * 再次解析到私网地址；重定向逐跳复用同一套网络策略。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { z } from 'zod';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { RecoverableError, describeError } from '../../domain/index.js';
import { assertFetchTarget, type ResolvedFetchTarget } from '../../security/network-policy.js';
import { defineTool } from '../define.js';

/** 工具自身的正文上限；ToolExecutor 还会按 limits.tool_output_max_bytes 二次裁剪。 */
const DEFAULT_MAX_CHARS = 120000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_REDIRECTS = 5;

interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
}

function allowedHosts(env: Record<string, string | undefined>): string[] {
  return (env.HAP_HTTP_FETCH_ALLOW_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

function requestTarget(
  target: ResolvedFetchTarget,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('请求已取消'));
      return;
    }
    let settled = false;
    const finish = (value: RawResponse): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const port = target.url.port || (target.url.protocol === 'https:' ? '443' : '80');
    const hostHeader = target.url.port ? `${target.url.hostname}:${target.url.port}` : target.url.hostname;
    const requestHeaders: Record<string, string> = { ...headers, host: hostHeader };
    if (body !== undefined && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(Buffer.byteLength(body));
    }
    const send = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send({
      hostname: target.address,
      family: target.family,
      port,
      path: target.url.pathname + target.url.search,
      method,
      headers: requestHeaders,
      ...(target.url.protocol === 'https:' ? { servername: target.url.hostname } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const complete = (): void => finish({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers: res.headers,
        body: Buffer.concat(chunks),
        truncated,
      });
      res.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_RESPONSE_BYTES - bytes;
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        bytes += buffer.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          truncated = true;
          res.destroy();
          complete();
        }
      });
      res.on('end', complete);
      res.on('error', fail);
    });
    const onAbort = (): void => {
      req.destroy(new Error('请求已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function fetchWithPolicy(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | undefined; signal: AbortSignal },
  allowHosts: readonly string[],
): Promise<RawResponse & { url: string }> {
  let current = new URL(url);
  let method = init.method;
  let body = init.body;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = await assertFetchTarget(current, allowHosts);
    const response = await requestTarget(target, method, init.headers, body, init.signal);
    const location = response.headers.location;
    const locationValue = Array.isArray(location) ? location[0] : location;
    if (![301, 302, 303, 307, 308].includes(response.status) || !locationValue) {
      return { ...response, url: current.toString() };
    }
    if (redirect === MAX_REDIRECTS) throw new Error('HTTP 重定向次数超过上限');
    current = new URL(locationValue, current);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }
  throw new Error('HTTP 重定向次数超过上限');
}

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
    if (args.body !== undefined && Buffer.byteLength(args.body) > MAX_REQUEST_BODY_BYTES) {
      throw new RecoverableError('TOOL_FAILED', 'HTTP 请求正文超过 1 MiB 上限');
    }

    let response: RawResponse & { url: string };
    try {
      response = await fetchWithPolicy(args.url, {
        method: args.method ?? 'GET',
        headers: args.headers ?? {},
        body: args.body,
        signal: ctx.signal,
      }, allowedHosts(ctx.env));
    } catch (error) {
      throw new RecoverableError('TOOL_FAILED', 'HTTP 请求失败：' + args.url + ' —— ' + describeError(error), {
        context: { url: args.url },
      });
    }

    const text = response.body.toString('utf8');
    const limit = args.max_chars ?? DEFAULT_MAX_CHARS;
    const wasClipped = response.truncated || text.length > limit;
    const clipped = text.length > limit ? text.slice(0, limit) : text;
    const suffix = wasClipped ? '\n…（正文已按安全上限截断）' : '';
    const rawContentType = response.headers['content-type'];
    const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType ?? '未声明';
    const header = 'HTTP ' + response.status + ' ' + response.statusText + '\ncontent-type: ' + contentType + '\nurl: ' + response.url;
    return { content: header + '\n\n' + clipped + suffix, isError: response.status < 200 || response.status >= 300 };
  },
});
