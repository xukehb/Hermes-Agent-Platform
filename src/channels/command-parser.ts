/**
 * 通道命令与 @mention 解析（FR-CHAN-003/004）。
 *
 * 解析规则刻意保持保守：只有以斜杠开头的首个 token 才被当作命令，
 * 其余一律视为提示词原文，避免用户正常提问里的斜杠被误吞。
 *
 * 日期：2026-08-24  执行者：Codex
 */

/** 已支持的通道命令。 */
export type ChannelCommand =
  | { kind: 'prompt'; text: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'model'; modelName?: string }
  | { kind: 'models' }
  | { kind: 'projects' }
  | { kind: 'project'; target?: string }
  | { kind: 'git' }
  | { kind: 'diff'; file?: string }
  | { kind: 'commit'; message?: string }
  | { kind: 'push' }
  | { kind: 'sh'; command: string }
  | { kind: 'skills' }
  | { kind: 'plugins' }
  | { kind: 'reload' }
  | { kind: 'trace'; taskId?: string }
  | { kind: 'agent'; agentId?: string }
  | { kind: 'agents' }
  | { kind: 'usage'; days: number }
  | { kind: 'new' }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

/** @mention 解析结果。 */
export interface MentionMatch {
  agentId?: string;
  text: string;
}

/**
 * 唤起词判定结果（FR-CHAN-014）。
 *
 * wake 表示这条消息是否在向机器人说话；text 是剥掉唤起词后的正文。
 * 私聊里全部消息都算唤起，群聊里只有命中唤起词或斜杠命令才算。
 */
export interface WakeMatch {
  wake: boolean;
  text: string;
}

const USAGE_DEFAULT_DAYS = 7;

/**
 * 把 Telegram 的 /cmd@botname 形式还原成 cmd。
 * 群聊里客户端会自动补 @botname，不去掉会导致命令永远落到 unknown 分支。
 */
function normalizeCommandName(raw: string): string {
  const at = raw.indexOf('@');
  const name = at === -1 ? raw : raw.slice(0, at);
  return name.toLowerCase();
}

/**
 * 解析一条入站文本。
 *
 * 返回 prompt 时 text 已 trim；命令参数按空白切分，多余参数忽略而不报错，
 * 因为手机端输入容易带上多余空格，报错只会让用户重打一遍。
 */
export function parseCommand(raw: string): ChannelCommand {
  const text = raw.trim();
  if (!text.startsWith('/')) {
    return { kind: 'prompt', text };
  }
  const parts = text.slice(1).split(/\s+/).filter((part) => part.length > 0);
  const name = normalizeCommandName(parts[0] ?? '');
  const args = parts.slice(1);
  switch (name) {
    case 'stop':
    case 'cancel':
      return { kind: 'stop' };
    case 'status':
      return { kind: 'status' };
    case 'model': {
      const modelName = args[0];
      return modelName === undefined ? { kind: 'model' } : { kind: 'model', modelName };
    }
    case 'models':
      return { kind: 'models' };
    case 'projects':
      return { kind: 'projects' };
    case 'project': {
      const target = args.join(' ').trim();
      return target === '' ? { kind: 'project' } : { kind: 'project', target };
    }
    case 'git':
      return { kind: 'git' };
    case 'diff': {
      const file = args[0];
      return file === undefined ? { kind: 'diff' } : { kind: 'diff', file };
    }
    case 'commit': {
      const message = args.join(' ').trim();
      return message === '' ? { kind: 'commit' } : { kind: 'commit', message };
    }
    case 'push':
      return { kind: 'push' };
    case 'sh':
    case 'run':
    case 'exec':
      return { kind: 'sh', command: args.join(' ') };
    case 'skills':
    case 'skill':
      return { kind: 'skills' };
    case 'plugins':
    case 'plugin':
    case 'mcp':
      return { kind: 'plugins' };
    case 'reload':
    case 'restart':
      return { kind: 'reload' };
    case 'trace': {
      const taskId = args[0];
      return taskId === undefined ? { kind: 'trace' } : { kind: 'trace', taskId };
    }
    case 'agent': {
      const agentId = args[0];
      return agentId === undefined ? { kind: 'agent' } : { kind: 'agent', agentId };
    }
    case 'agents':
      return { kind: 'agents' };
    case 'usage': {
      const parsed = Number.parseInt(args[0] ?? '', 10);
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : USAGE_DEFAULT_DAYS;
      return { kind: 'usage', days };
    }
    case 'new':
    case 'reset':
      return { kind: 'new' };
    case 'help':
    case 'start':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name };
  }
}

/**
 * 从正文里摘出 @mention 指定的智能体。
 *
 * knownAgents 为已声明的智能体 id 列表：只有 token 命中其中之一才算指派，
 * 否则整条原文保留。这一点至关重要 —— 群聊里 @某个群友 或 @机器人用户名
 * 都会以 @ 开头，若不校验白名单就会被误当成智能体 id 送进路由并炸出
 * AGENT_NOT_FOUND。传空数组表示不做校验（CLI 单人场景，token 即 id）。
 *
 * 只识别出现在开头的 mention，句中出现的 @xxx 属于正常语义，不该改变路由。
 */
export function extractMention(raw: string, knownAgents: readonly string[]): MentionMatch {
  const text = raw.trimStart();
  if (!text.startsWith('@')) {
    return { text: raw.trim() };
  }
  const match = /^@([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(text);
  if (match === null) {
    return { text: raw.trim() };
  }
  const token = match[1] ?? '';
  const rest = (match[2] ?? '').trim();
  const agentId = resolveAgentToken(token, knownAgents);
  if (agentId === undefined) {
    return { text: raw.trim() };
  }
  return { agentId, text: rest };
}

/**
 * 把 mention token 映射回智能体 id。
 *
 * 大小写不敏感：手机键盘的首字母自动大写会让 @Coder 打不中 coder。
 * knownAgents 为空时按「token 即 id」处理，交由上层路由去校验存在性。
 */
function resolveAgentToken(token: string, knownAgents: readonly string[]): string | undefined {
  if (token.length === 0) {
    return undefined;
  }
  if (knownAgents.length === 0) {
    return token;
  }
  const lower = token.toLowerCase();
  for (const id of knownAgents) {
    if (id.toLowerCase() === lower) {
      return id;
    }
  }
  return undefined;
}

/**
 * 判定一条群聊消息是否在向机器人说话，并剥掉唤起前缀（FR-CHAN-014）。
 *
 * 命中任一即算唤起：
 * 1) 斜杠命令 —— 群里打 /status 显然是在跟机器人讲话；
 * 2) 配置的唤起词（channels.telegram.mention_patterns，如 @hap）；
 * 3) @<已声明智能体 id> —— 直接点名执行者本身就是唤起。
 *
 * 第 3 条必须在这里判，不能只靠唤起词：否则群里发 @writer 写周报 会被静默忽略，
 * 而这恰恰是最自然的用法。唤起词命中后要把前缀剥掉，剩下的正文可能仍带
 * @智能体 前缀（如 @hap @writer 写周报），交给 extractMention 二次解析。
 */
export function stripWakeWord(
  raw: string,
  wakePatterns: readonly string[],
  knownAgents: readonly string[],
): WakeMatch {
  const text = raw.trim();
  if (text.startsWith('/')) {
    return { wake: true, text };
  }
  for (const pattern of wakePatterns) {
    const word = pattern.startsWith('@') ? pattern : '@' + pattern;
    if (!startsWithWord(text, word)) {
      continue;
    }
    return { wake: true, text: text.slice(word.length).trim() };
  }
  if (extractMention(text, knownAgents).agentId !== undefined) {
    return { wake: true, text };
  }
  return { wake: false, text };
}

/**
 * 前缀匹配且后随词边界。
 *
 * 不加边界判断会让唤起词 @hap 误吞 @happy-agent 这类更长的 token，
 * 把 py-agent 当成正文发给模型。
 */
function startsWithWord(text: string, word: string): boolean {
  if (text.length < word.length) {
    return false;
  }
  if (text.slice(0, word.length).toLowerCase() !== word.toLowerCase()) {
    return false;
  }
  const next = text.charAt(word.length);
  return next === '' || /[\s\p{P}]/u.test(next);
}
