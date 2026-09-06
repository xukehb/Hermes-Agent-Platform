/**
 * HTTP 通道（FR-CHAN-011/012）。
 *
 * 定位是「本机自动化入口」：脚本、Shortcuts、其他智能体都能用一条 curl 下发任务。
 * 用 hono 承载路由，@hono/node-server 落地监听，不自建 HTTP 框架。
 * 提供同步 /run（拿最终结果）与 SSE /stream（拿事件流）两种形态，
 * 前者适合脚本，后者适合需要看进度的调用方。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { ChannelDispatcher, describeError, renderStatus, renderTrace } from './dispatcher.js';
import { OutboundSender } from './outbound.js';
import { parseBind } from './bind.js';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { Channel, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../config/index.js';
import type { RunTaskRequest, TaskEvent } from '../agent/index.js';

export interface HttpChannelOptions {
  host: ChannelHost;
  channels: ResolvedChannels;
  limits: ResolvedLimits;
  paths: ResolvedPaths;
  authToken?: string | undefined;
  maxBodyBytes?: number | undefined;
  log?: (line: string) => void;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === 'ip6-localhost') return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith('127.');
  if (family === 6) return normalized === '::1' || normalized.startsWith('::ffff:127.');
  return false;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function contentLength(request: Request): number | undefined {
  const raw = request.headers.get('content-length');
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function exceedsBodyLimit(request: Request, limit: number): Promise<boolean> {
  const declared = contentLength(request);
  if (declared !== undefined && declared > limit) return true;
  if (request.body === null) return false;
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return false;
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** /run 与 /stream 的公共请求体。 */
interface RunBody {
  input?: unknown;
  agent?: unknown;
  model?: unknown;
  session?: unknown;
}

/**
 * HTTP 通道实现。
 *
 * 与 Telegram 共用 ChannelDispatcher 处理命令语义，
 * 因此 /message 端点同样支持 /status、/trace 这些斜杠命令。
 */
export class HttpChannel implements Channel {
  readonly name = 'http' as const;

  private readonly options: HttpChannelOptions;
  private readonly app: Hono;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private server: { close: () => void } | undefined;

  constructor(options: HttpChannelOptions) {
    this.options = options;
    this.sender = new OutboundSender(options.paths.spoolDir);
    this.dispatcher = new ChannelDispatcher({
      host: options.host,
      sender: this.sender,
      // HTTP 响应体没有长度限制，分片只会破坏 JSON 结构
      messageCharLimit: 0,
      editIntervalMs: options.channels.editIntervalMs,
      asyncThresholdMs: 0,
      queueCapacity: options.limits.ingressQueueSize,
    });
    this.app = this.buildApp();
  }

  /** 暴露 fetch 处理器，便于测试直接用 Request/Response 打点。 */
  get fetch(): (request: Request) => Response | Promise<Response> {
    return this.app.fetch;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }
    const address = parseBind(this.options.channels.http.bind);
    const maxBodyBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
      throw new Error('HTTP 通道 maxBodyBytes 必须是正整数');
    }
    if (!isLoopbackHost(address.host) && !this.options.authToken?.trim()) {
      throw new Error('非回环 HTTP 通道监听必须配置 authToken');
    }
    this.server = serve({ fetch: this.app.fetch, hostname: address.host, port: address.port });
    this.options.log?.('HTTP 通道已监听 http://' + address.host + ':' + String(address.port));
  }

  async stop(): Promise<void> {
    await this.dispatcher.drain();
    this.server?.close();
    this.server = undefined;
  }

  private buildApp(): Hono {
    const app = new Hono();
    const host = this.options.host;
    const authToken = this.options.authToken?.trim();
    const maxBodyBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

    app.use('*', async (c, next) => {
      if (authToken !== undefined && !safeEqual(bearerToken(c.req.raw) ?? '', authToken)) {
        return c.json({ error: 'Unauthorized: 无效的安全访问凭据' }, 401);
      }
      if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
        if (await exceedsBodyLimit(c.req.raw, maxBodyBytes)) {
          return c.json({ error: '请求体过大' }, 413);
        }
      }
      await next();
    });

    app.get('/health', (c) => c.json({ ok: true, agents: host.agentIds() }));

    app.get('/agents', (c) => c.json({ agents: host.agentIds() }));

    app.get('/status/:session', (c) => {
      const session = c.req.param('session');
      const status = host.status(session, this.options.channels.http.defaultAgent);
      return c.json({ status, text: renderStatus(status) });
    });

    app.get('/trace/:taskId', (c) => {
      const summary = host.trace(c.req.param('taskId'));
      if (summary === undefined) {
        return c.json({ error: '找不到该任务' }, 404);
      }
      return c.json({ trace: summary, text: renderTrace(summary) });
    });

    app.get('/usage', (c) => {
      const days = Number.parseInt(c.req.query('days') ?? '7', 10);
      const span = Number.isFinite(days) && days > 0 ? days : 7;
      const since = new Date(Date.now() - span * 86_400_000).toISOString();
      return c.json({ days: span, rows: host.usageSince(since) });
    });

    app.post('/stop/:session', (c) => {
      const aborted = host.abortSession(c.req.param('session'));
      return c.json({ aborted });
    });

    // 同步执行：拿最终结果，适合脚本调用
    app.post('/run', async (c) => {
      let body: RunBody;
      try {
        body = (await c.req.json()) as RunBody;
      } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400);
      }
      const input = typeof body.input === 'string' ? body.input.trim() : '';
      if (input.length === 0) {
        return c.json({ error: 'input 不能为空' }, 400);
      }
      const request = this.toRequest(body, input);
      try {
        const outcome = await host.runTask(request);
        return c.json({
          taskId: outcome.taskId,
          agentId: outcome.agentId,
          status: outcome.status,
          model: outcome.model,
          protocol: outcome.protocol,
          text: outcome.text,
          reasoning: outcome.reasoning,
          usage: outcome.usage,
          iterations: outcome.iterations,
          stopReason: outcome.stopReason,
          tracePath: outcome.tracePath,
          error: outcome.error,
        });
      } catch (error) {
        return c.json({ error: describeError(error) }, 500);
      }
    });

    // 流式执行：SSE 推事件，适合需要看进度的调用方
    app.post('/stream', async (c) => {
      let body: RunBody;
      try {
        body = (await c.req.json()) as RunBody;
      } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400);
      }
      const input = typeof body.input === 'string' ? body.input.trim() : '';
      if (input.length === 0) {
        return c.json({ error: 'input 不能为空' }, 400);
      }
      const request = this.toRequest(body, input);
      return streamSSE(c, async (stream) => {
        const pending: TaskEvent[] = [];
        request.onEvent = (event) => {
          pending.push(event);
        };
        let flushing = true;
        const pump = async (): Promise<void> => {
          while (flushing || pending.length > 0) {
            const event = pending.shift();
            if (event === undefined) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              continue;
            }
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        };
        const pumping = pump();
        try {
          const outcome = await host.runTask(request);
          flushing = false;
          await pumping;
          await stream.writeSSE({ event: 'done', data: JSON.stringify(outcome) });
        } catch (error) {
          flushing = false;
          await pumping;
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: describeError(error) }) });
        }
      });
    });

    // 命令语义端点：与 Telegram 完全一致的斜杠命令处理
    app.post('/message', async (c) => {
      let body: RunBody;
      try {
        body = (await c.req.json()) as RunBody;
      } catch {
        return c.json({ error: '请求体必须是 JSON' }, 400);
      }
      const text = typeof body.input === 'string' ? body.input : '';
      const session = typeof body.session === 'string' && body.session.length > 0 ? body.session : 'http:default';
      const replies: string[] = [];
      const target: OutboundTarget = {
        channel: 'http',
        targetId: session,
        send: async (chunk: string) => {
          replies.push(chunk);
          return undefined;
        },
      };
      const message: InboundMessage = {
        channel: 'http',
        sessionKey: session,
        text,
        receivedAt: new Date().toISOString(),
        target,
      };
      if (typeof body.agent === 'string' && body.agent.length > 0) {
        message.agentId = body.agent;
      }
      if (this.options.channels.http.defaultAgent !== undefined) {
        message.defaultAgent = this.options.channels.http.defaultAgent;
      }
      await this.dispatcher.handle(message);
      return c.json({ session, replies, text: replies.join('\n\n') });
    });

    return app;
  }

  /** 把 HTTP 请求体折成编排层入参。 */
  private toRequest(body: RunBody, input: string): RunTaskRequest {
    const request: RunTaskRequest = { input };
    if (typeof body.agent === 'string' && body.agent.length > 0) {
      request.agentId = body.agent;
    }
    if (typeof body.model === 'string' && body.model.trim().length > 0) {
      request.model = body.model.trim();
    }
    if (typeof body.session === 'string' && body.session.length > 0) {
      request.sessionKey = body.session;
    } else {
      request.sessionKey = 'http:default';
    }
    if (this.options.channels.http.defaultAgent !== undefined) {
      request.channelDefaultAgent = this.options.channels.http.defaultAgent;
    }
    return request;
  }
}
