/**
 * 监听地址解析。
 *
 * 配置里统一写 host:port 字符串（如 127.0.0.1:8787），
 * 这里拆成 @hono/node-server 需要的 hostname + port。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { ConfigError } from '../domain/index.js';

export interface BindAddress {
  host: string;
  port: number;
}

/** 解析 host:port；缺 host 时按 127.0.0.1 处理。 */
export function parseBind(bind: string): BindAddress {
  const trimmed = bind.trim();
  const index = trimmed.lastIndexOf(':');
  if (index === -1) {
    const onlyPort = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(onlyPort) || onlyPort <= 0) {
      throw new ConfigError('CONFIG_INVALID', '无法解析监听地址：' + bind, { bind });
    }
    return { host: '127.0.0.1', port: onlyPort };
  }
  const host = trimmed.slice(0, index);
  const port = Number.parseInt(trimmed.slice(index + 1), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new ConfigError('CONFIG_INVALID', '无法解析监听端口：' + bind, { bind });
  }
  return { host: host.length === 0 ? '127.0.0.1' : host, port };
}
