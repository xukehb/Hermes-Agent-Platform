import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChannelName } from './types.js';
import type { AgentMessage, MessageRole } from '../domain/index.js';

/**
 * 规范化联系人名称，去除桌面 OCR 常见的首尾标点、引号、空格与未读计数徽标。
 */
export function normalizeContactName(raw: string): string {
  if (!raw) return '';
  let s = raw.trim();
  for (let i = 0; i < 3; i++) {
    const prev = s;
    // 1. 去除首尾中英文引号与特殊包裹符号
    s = s.replace(/^["'“”‘’「」『』《》〈〉]+|["'“”‘’「」『』《》〈〉]+$/g, '').trim();
    // 2. 去除末尾的未读数或括号数字（例如 "平安喜樂 (1)", "平安喜樂（2）"）
    s = s.replace(/[(（\[]\d+[)）\]]$/, '').trim();
    // 3. 去除首尾常见标点符号与空格（句号、逗号、问号、叹号、省略号、中间点等）
    s = s.replace(/^[。，、？！…·.?!,:;\s]+|[。，、？！…·.?!,:;\s]+$/g, '').trim();
    if (s === prev) break;
  }
  // 特殊已知屏幕 OCR 错别字纠正（如“喜樂”被视觉错识为“支缴”）
  if (s === '平安支缴') return '平安喜樂';
  return s;
}

/**
 * 规范化联系人标识 ID。
 * 针对普通中文或 OCR 识别出的带标点 ID 进行去噪，保留标准协议 ID（如 wx_user_xxx, telegram:123）。
 */
export function normalizeContactId(rawId: string): string {
  if (!rawId) return '';
  const trimmed = rawId.trim();
  if (
    /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+/.test(trimmed) ||
    /^(wx_user_|feishu_|qq_|dingtalk_)/.test(trimmed)
  ) {
    return trimmed;
  }
  return normalizeContactName(trimmed) || trimmed;
}

/**
 * 识别是否为由屏幕 OCR 误识别捕获的垃圾假联系人、时间戳或窗口标题。
 */
export function isGarbageContactName(nameOrId: string): boolean {
  if (!nameOrId) return true;
  const s = nameOrId.trim();
  if (s.length <= 1) return true;

  // 1. 绝对文件路径、主目录路径或 IDE 窗口标题/插件状态/文件扩展名与文档预览、网络 URL、Email 地址
  if (/^(\/|~|[a-zA-Z]:[\\/])/.test(s)) return true;
  if (/^https?:\/\/|www\.|\.xyz[\/\b]|\.com[\/\b]|\.cn[\/\b]|\.top[\/\b]|\.net[\/\b]|\.org[\/\b]/i.test(s)) return true;
  if (/@(?:gmail|hotmail|qq|163|outlook|foxmail|126)\./i.test(s)) return true;
  if (/manifest\.json|HBuilder|VS Code|node_modules|macos_ocr|\.docx?|\.xlsx?|\.pptx?|\.pdf|\.zip|\.rar|\.dmg|\.pkg|\.json|\.ts|\.js|\.md|\.exe|\.vue|\.html|\.css|Worked for|Working|reasonix|deepseek|需求文档|个人中心|接口文档|设计稿|原型图/i.test(s)) return true;

  // 2. 非联系人界面系统占位符与官方系统号/预览窗口
  if (/^(?:公众号|微信团队|文件传输助手|我|Q 搜終|搜索|消息|通讯录|订阅号|微信支付|页面|图片浏览|视频播放)$/.test(s)) return true;

  // 3. 编号清单行或日志行末尾（如 "1.底层引擎升级："，冒号结尾）
  if (/^\d+[\.、]/.test(s) || /[:：]$/.test(s)) return true;

  // 4. 时间与日期标识（包括常见的视觉 OCR 错别字如昨灭、靠天、非天、我天、坐期五等）
  if (/(?:昨天|前天|今天|昨灭|靠天|非天|我天|壽关|天)\s*\d{1,2}[:.：-]/i.test(s)) return true;
  if (/(?:昨天|前天|今天|昨灭|非天|我天)\d{4}/i.test(s)) return true;
  if (/^(?:星期|周|坐期)[一二三四五六日天]/.test(s)) return true;
  if (/^\d{1,2}[-:\/.点：]\d{1,2}[|]?$/.test(s)) return true;
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?$/i.test(s)) return true;

  // 5. 聊天气泡切片（包含换行，或首尾标点剥离后仍包含句子标点如逗号、句内句号、感叹号、问号、分号等）
  if (/\n/.test(s)) return true;
  const canon = normalizeContactName(s);
  if (!canon || canon.length === 0) return true;
  if (/[，。？！…；;?!]/.test(canon)) return true;

  // 6. 常见聊天问候/问句/状态误识别为联系人
  if (/^(?:你在干嘛|你在干什么|在干嘛|在干嘛呢|在吗|在不在|哈哈|好的|收到)$/.test(s)) return true;

  // 7. 口语句式/代词片段 (如包含 "这块"、"这烧"、"怎么"、"什么" 等非人名虚词)
  if (/(?:这块|这烧|这波|这届|那个|怎么|什么|为什么|如何)/.test(s)) return true;

  // 8. 异常离散词片 (中文字符间夹杂多个空格，如 '件 造成 自闭白然')
  if (/[\u4e00-\u9fa5]\s+[\u4e00-\u9fa5]/.test(s) && (s.match(/\s+/g) || []).length >= 2) return true;

  return false;
}

/**
 * 识别是否为大模型调用失败或凭据拒绝等系统异常报错文本。
 */
export function isErrorMessage(text: string): boolean {
  if (!text) return true;
  return (
    text.includes('✗ 任务失败') ||
    text.includes('（本次没有产生正文输出）') ||
    text.includes('服务商拒绝了当前凭据') ||
    text.includes('尚未配置 API Key') ||
    text.includes('HTTP 403') ||
    text.includes('HTTP 401') ||
    text.includes('HTTP 500') ||
    text.includes('token quota is not enough') ||
    text.includes('insufficient_quota') ||
    text.includes('RateLimitError') ||
    text.includes('AuthenticationError') ||
    text.includes('降级链全部失败') ||
    text.includes('模型调用失败')
  );
}

export interface ChannelContact {
  id: string; // 联系人或群聊唯一标识 (如 wx_user_xxx, feishu_chat_xxx, qq_group_123)
  channel: ChannelName;
  name: string; // 显示名称 (如 "张三 (架构师)", "飞书研发核心群", "QQ架构交流群")
  type: 'user' | 'room';
  isRoom: boolean;
  avatar?: string | undefined;
  agentId?: string | undefined; // 绑定的专属自动回复智能体 (coder, reviewer, ops, researcher 等)
  autoReply: boolean; // 是否开启自动回复
  replyMode?: 'all' | 'mention' | 'manual' | undefined; // 全量自动回复 / 仅@时回复 / 仅手动监控
  hostingMode?: 'auto' | 'draft' | 'mention' | 'manual' | 'off' | undefined; // 聊天托管模式：全自动 / 半托管草稿 / 仅@ / 仅监控 / 关闭
  systemPrompt?: string | undefined; // 该好友或群聊专属的人设 Prompt
  cooldownUntil?: number | undefined; // 人工回复后的防撞车冷却截止时间戳 (ms)
  cooldownMinutes?: number | undefined; // 默认人工冷却分钟数 (默认 10 分钟)
  humanTakenOver?: boolean | undefined; // 是否处于人工接管锁定状态
  delayMs?: number | undefined; // 拟人化打字与思考延迟时间 (ms)
  workspace?: string | undefined; // 绑定的专属工程工作区
  lastMessage?: string | undefined;
  lastSender?: string | undefined; // 最后发送人姓名
  lastTime?: string | undefined;
  unreadCount?: number | undefined;
  aliases?: string[] | undefined; // 历史识别别名 / 标题浮动别名（如 ["平安喜樂。", "平安喜樂”。"]）
  facts?: string[] | undefined; // 联系人专属画像事实认知库（如 ["常驻深圳", "从事跨境电商"]）
}

export interface ChannelChatMessage {
  id: string;
  channel: ChannelName;
  contactId: string;
  fromId: string;
  fromName: string;
  isRoom: boolean;
  roomName?: string | undefined;
  sender: 'user' | 'agent' | 'human' | 'system'; // human = 用户在托管界面或手机端真实发出的消息
  agentId?: string | undefined;
  text: string;
  time: string;
  timestamp: number;
  isDraft?: boolean | undefined; // 是否为半托管待确认草稿
  draftStatus?: 'pending' | 'sent' | 'discarded' | undefined; // 草稿状态
  elapsedMs?: number | undefined; // AI 代答耗时毫秒
}

export interface ChannelDefaultPolicy {
  agentId?: string | undefined;
  systemPrompt?: string | undefined;
  hostingMode?: 'auto' | 'draft' | 'mention' | 'manual' | 'off' | undefined;
  cooldownMinutes?: number | undefined;
  delayMs?: number | undefined;
}

interface ChannelContactStoreData {
  contacts: ChannelContact[];
  messages: ChannelChatMessage[];
  defaults?: Partial<Record<ChannelName, ChannelDefaultPolicy>> | undefined;
}

const DATA_PATH = join(homedir(), '.hap', 'universal_contacts.json');

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class ChannelContactStore {
  private static instance: ChannelContactStore;
  private readonly filePath: string;

  constructor(filePath: string = DATA_PATH) {
    this.filePath = filePath;
  }

  static getInstance(filePath: string = DATA_PATH): ChannelContactStore {
    if (!ChannelContactStore.instance || ChannelContactStore.instance.filePath !== filePath) {
      ChannelContactStore.instance = new ChannelContactStore(filePath);
    }
    return ChannelContactStore.instance;
  }

  static resetInstance(): void {
    ChannelContactStore.instance = undefined as unknown as ChannelContactStore;
  }

  load(): ChannelContactStoreData {
    ensureDir(this.filePath);
    if (!existsSync(this.filePath)) {
      const initial: ChannelContactStoreData = { contacts: [], messages: [], defaults: {} };
      this.save(initial);
      return initial;
    }

    try {
      const text = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(text) as Partial<ChannelContactStoreData>;
      const contacts = Array.isArray(data.contacts) ? data.contacts : [];
      const messages = Array.isArray(data.messages) ? data.messages : [];
      // 自动清理历史遗留的假 Mock 数据
      const realContacts = contacts.filter((c) => !c.id.startsWith('wx_user_zhangsan') && !c.id.startsWith('wx_room_tech_arch'));
      const defaults = (data.defaults && typeof data.defaults === 'object') ? data.defaults : {};

      // 自动合并与清洗因 OCR 标题噪点（标点、引号、空格等）导致的碎片联系人
      let mutated = false;
      const canonicalMap = new Map<string, ChannelContact>();
      const idRedirectMap = new Map<string, string>(); // oldId -> canonicalId

      for (const c of realContacts) {
        if (isGarbageContactName(c.id) || isGarbageContactName(c.name)) {
          mutated = true;
          continue;
        }

        const canonId = normalizeContactId(c.id);
        const canonName = normalizeContactName(c.name) || canonId;
        const groupKey = `${c.channel}:${c.isRoom ? 'room' : 'user'}:${canonId}`;

        if (canonicalMap.has(groupKey)) {
          // 发现重复碎片联系人，合并至 canonical 联系人
          const canonical = canonicalMap.get(groupKey)!;
          mutated = true;
          idRedirectMap.set(c.id, canonical.id);

          // 合并别名
          const aliasSet = new Set(canonical.aliases || []);
          aliasSet.add(c.id);
          aliasSet.add(c.name);
          if (c.aliases) {
            for (const a of c.aliases) aliasSet.add(a);
          }
          canonical.aliases = Array.from(aliasSet).filter((a) => a !== canonical.id);

          // 合并事实画像
          if (c.facts && c.facts.length > 0) {
            const factSet = new Set(canonical.facts || []);
            for (const f of c.facts) factSet.add(f);
            canonical.facts = Array.from(factSet);
          }

          // 保留有效的人设与配置
          if (!canonical.systemPrompt && c.systemPrompt) canonical.systemPrompt = c.systemPrompt;
          if ((!canonical.agentId || canonical.agentId === 'coder') && c.agentId && c.agentId !== 'coder') {
            canonical.agentId = c.agentId;
          }
          if (c.workspace && !canonical.workspace) canonical.workspace = c.workspace;

          // 保留较新的最后消息
          if (c.lastTime && (!canonical.lastTime || c.lastTime > canonical.lastTime)) {
            canonical.lastMessage = c.lastMessage || canonical.lastMessage;
            canonical.lastSender = c.lastSender || canonical.lastSender;
            canonical.lastTime = c.lastTime;
          }
        } else {
          // 首次出现，归一化 ID 与 Name
          const updatedContact: ChannelContact = {
            ...c,
            id: canonId,
            name: canonName,
          };
          if (canonId !== c.id) {
            mutated = true;
            idRedirectMap.set(c.id, canonId);
            const aliasSet = new Set(updatedContact.aliases || []);
            aliasSet.add(c.id);
            aliasSet.add(c.name);
            updatedContact.aliases = Array.from(aliasSet).filter((a) => a !== canonId);
          }
          canonicalMap.set(groupKey, updatedContact);
        }
      }

      // 重定向消息所属的 contactId 并过滤报错与垃圾联系人消息
      const finalContacts = Array.from(canonicalMap.values());
      const redirectedMessages = messages
        .filter((m) => {
          if (isErrorMessage(m.text)) {
            mutated = true;
            return false;
          }
          if (isGarbageContactName(m.contactId) || isGarbageContactName(m.fromId)) {
            mutated = true;
            return false;
          }
          // 过滤屏幕输入工具栏误触残留的杂音符号消息（如 "©", "G口*、心", "口*、白"）及其引起的 AI 误答
          if (
            /^[日、凶这口⑨×…•©·\+\s*、G心白]+$/.test(m.text.trim()) ||
            m.fromName === '平安支缴' ||
            (m.sender === 'agent' && /怎么突然发个G|玩猜心游戏|玩摩斯密码|又换符号了|发个版权符号|一个字母加个符号/.test(m.text))
          ) {
            mutated = true;
            return false;
          }
          // 过滤 AI 误读自己屏幕气泡错别字产生的自言自语死循环回音
          if (
            /披奇提有点不好题思了|被考得有点不好意思了/.test(m.text) ||
            (m.sender === 'agent' && /没事没事，我心理素质还是可以的|害 别这么说嘛/.test(m.text))
          ) {
            mutated = true;
            return false;
          }
          return true;
        })
        .map((m) => {
          const redirected = idRedirectMap.get(m.contactId);
          let targetMsg = m;
          if (redirected) {
            mutated = true;
            targetMsg = { ...m, contactId: redirected };
          }
          // 修正历史记录中用户真实发出的短消息被误标为联系人发来的异常
          if (
            targetMsg.contactId === '平安喜樂' &&
            (targetMsg.text === '晚安晚安' || targetMsg.text === '我在升级一下') &&
            targetMsg.sender === 'user'
          ) {
            mutated = true;
            targetMsg = {
              ...targetMsg,
              sender: 'human',
              fromId: 'user_human',
              fromName: '我 (人工回复)',
            };
          }
          return targetMsg;
        })
        .filter((m) => finalContacts.some((c) => c.id === m.contactId));

      // 同步更新联系人的 lastMessage
      finalContacts.forEach((c) => {
        const cMsgs = redirectedMessages.filter((m) => m.contactId === c.id);
        if (cMsgs.length > 0) {
          const lastM = cMsgs[cMsgs.length - 1]!;
          c.lastMessage = lastM.text.slice(0, 80);
          c.lastSender = lastM.sender === 'human'
            ? '我 (人工回复)'
            : (lastM.sender === 'user' ? (lastM.fromName || c.name) : `AI (${lastM.agentId || 'xx'})`);
          c.lastTime = lastM.time || c.lastTime;
        }
      });

      const result: ChannelContactStoreData = {
        contacts: finalContacts,
        messages: redirectedMessages,
        defaults,
      };

      if (mutated) {
        this.save(result);
      }
      return result;
    } catch {
      return { contacts: [], messages: [], defaults: {} };
    }
  }

  /**
   * 一键深度清理历史遗留的 OCR 噪点假联系人、系统报错气泡与孤立消息。
   */
  pruneGarbageContacts(channel?: ChannelName): { removedContacts: number; removedMessages: number } {
    let rawContactsCount = 0;
    let rawMessagesCount = 0;
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        if (Array.isArray(parsed.contacts)) rawContactsCount = parsed.contacts.length;
        if (Array.isArray(parsed.messages)) rawMessagesCount = parsed.messages.length;
      }
    } catch {}

    const data = this.load();
    const initialContactsCount = Math.max(rawContactsCount, data.contacts.length);
    const initialMessagesCount = Math.max(rawMessagesCount, data.messages.length);

    data.contacts = data.contacts.filter((c) => {
      if (channel && c.channel !== channel) return true;
      return !isGarbageContactName(c.id) && !isGarbageContactName(c.name);
    });

    const validContactIds = new Set(data.contacts.map((c) => c.id));
    data.contacts.forEach((c) => {
      if (c.aliases) {
        c.aliases.forEach((a) => validContactIds.add(a));
      }
    });

    data.messages = data.messages.filter((m) => {
      if (channel && m.channel !== channel) return true;
      if (isGarbageContactName(m.contactId) || isGarbageContactName(m.fromId)) return false;
      if (isErrorMessage(m.text)) return false;
      return validContactIds.has(m.contactId);
    });

    // 清理残留在联系人概览上的大模型异常报错气泡 (如 ✗ 任务失败 / HTTP 403)
    data.contacts.forEach((c) => {
      if (c.lastMessage && isErrorMessage(c.lastMessage)) {
        const contactMsgs = data.messages.filter((m) => m.contactId === c.id || (c.aliases && c.aliases.includes(m.contactId)));
        const cleanMsgs = contactMsgs.filter((m) => !isErrorMessage(m.text));
        const lastClean = cleanMsgs.length > 0 ? cleanMsgs[cleanMsgs.length - 1] : undefined;
        if (lastClean) {
          c.lastMessage = lastClean.text;
          c.lastSender = lastClean.fromName || (lastClean.sender === 'user' ? c.name : 'AI');
          c.lastTime = lastClean.time || (lastClean.timestamp ? new Date(lastClean.timestamp).toLocaleTimeString() : c.lastTime);
        } else {
          c.lastMessage = undefined;
          c.lastSender = undefined;
        }
      }
    });

    this.save(data);
    return {
      removedContacts: initialContactsCount - data.contacts.length,
      removedMessages: initialMessagesCount - data.messages.length,
    };
  }

  save(data: ChannelContactStoreData): void {
    ensureDir(this.filePath);
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  getDefaultPolicy(channel: ChannelName = 'wechat'): ChannelDefaultPolicy {
    const data = this.load();
    return data.defaults?.[channel] || {};
  }

  saveDefaultPolicy(channel: ChannelName = 'wechat', policy: Partial<ChannelDefaultPolicy>): ChannelDefaultPolicy {
    const data = this.load();
    if (!data.defaults) {
      data.defaults = {};
    }
    const current = data.defaults[channel] || {};
    const updated: ChannelDefaultPolicy = {
      ...current,
      ...policy,
    };
    data.defaults[channel] = updated;
    this.save(data);
    return updated;
  }

  listContacts(channel?: ChannelName): ChannelContact[] {
    const list = this.load().contacts;
    if (channel) {
      return list.filter((c) => c.channel === channel);
    }
    return list;
  }

  getContact(id: string, channel?: ChannelName): ChannelContact | undefined {
    return this.findContact(id, channel);
  }

  findContact(identifier: string, channel?: ChannelName): ChannelContact | undefined {
    const list = this.listContacts(channel);
    if (!identifier) return undefined;
    const trimmed = identifier.trim();

    // 1. 精确 ID 匹配
    let match = list.find((c) => c.id === trimmed);
    if (match) return match;

    // 2. 归一化 ID 匹配
    const normId = normalizeContactId(trimmed);
    if (normId) {
      match = list.find((c) => c.id === normId || normalizeContactId(c.id) === normId);
      if (match) return match;
    }

    // 3. 精确或归一化 Name 匹配
    const normName = normalizeContactName(trimmed);
    if (normName) {
      match = list.find((c) => c.name === trimmed || normalizeContactName(c.name) === normName);
      if (match) return match;
    }

    // 4. 别名列表匹配
    match = list.find((c) => c.aliases && (c.aliases.includes(trimmed) || (normName ? c.aliases.includes(normName) : false)));
    if (match) return match;

    return undefined;
  }

  upsertContact(input: Partial<ChannelContact> & { id: string; channel: ChannelName; name: string }): ChannelContact {
    const data = this.load();
    const canonId = normalizeContactId(input.id);
    const existingIdx = data.contacts.findIndex(
      (c) => (c.id === input.id || c.id === canonId) && c.channel === input.channel,
    );
    const existing = existingIdx >= 0 ? data.contacts[existingIdx] : undefined;

    const contact: ChannelContact = {
      id: canonId,
      channel: input.channel,
      name: normalizeContactName(input.name) || input.name.trim(),
      type: input.type || (input.isRoom ? 'room' : 'user'),
      isRoom: input.isRoom ?? (input.type === 'room'),
      avatar: input.avatar ?? existing?.avatar,
      agentId: input.agentId !== undefined ? input.agentId : (existing?.agentId || 'coder'),
      autoReply: input.autoReply !== undefined ? input.autoReply : (existing?.autoReply ?? true),
      replyMode: input.replyMode !== undefined ? input.replyMode : (existing?.replyMode || 'all'),
      hostingMode: input.hostingMode !== undefined ? input.hostingMode : (existing?.hostingMode || (input.isRoom ? 'mention' : 'auto')),
      systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : existing?.systemPrompt,
      cooldownUntil: input.cooldownUntil !== undefined ? input.cooldownUntil : existing?.cooldownUntil,
      cooldownMinutes: input.cooldownMinutes !== undefined ? input.cooldownMinutes : (existing?.cooldownMinutes || 10),
      humanTakenOver: input.humanTakenOver !== undefined ? input.humanTakenOver : existing?.humanTakenOver,
      delayMs: input.delayMs !== undefined ? input.delayMs : (existing?.delayMs || 2500),
      workspace: input.workspace !== undefined ? input.workspace : existing?.workspace,
      lastMessage: input.lastMessage !== undefined ? input.lastMessage : existing?.lastMessage,
      lastSender: input.lastSender !== undefined ? input.lastSender : existing?.lastSender,
      lastTime: input.lastTime !== undefined ? input.lastTime : (existing?.lastTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      unreadCount: input.unreadCount !== undefined ? input.unreadCount : (existing?.unreadCount || 0),
      aliases: input.aliases !== undefined ? input.aliases : existing?.aliases,
      facts: input.facts !== undefined ? input.facts : existing?.facts,
    };

    if (existingIdx >= 0) {
      data.contacts[existingIdx] = contact;
    } else {
      data.contacts.unshift(contact);
    }

    this.save(data);
    return contact;
  }

  recordIncomingMessage(msg: {
    channel: ChannelName;
    fromId: string;
    fromName: string;
    isRoom: boolean;
    roomId?: string | undefined;
    roomName?: string | undefined;
    text: string;
    isHosting?: boolean | undefined;
    defaultAgent?: string | undefined;
  }): { contact: ChannelContact; messageRecord: ChannelChatMessage } {
    const data = this.load();
    const rawContactId = msg.isRoom && msg.roomId ? msg.roomId : msg.fromId;
    const rawContactName = msg.isRoom ? (msg.roomName || `群聊 (${rawContactId})`) : (msg.fromName || `用户 (${rawContactId})`);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let contact = this.findContact(rawContactId, msg.channel);
    if (!contact && !msg.isRoom) {
      const normFromId = normalizeContactId(msg.fromId);
      const normFromName = normalizeContactName(msg.fromName);
      contact = this.findContact(normFromId, msg.channel) || this.findContact(normFromName, msg.channel);
    }

    if (!contact) {
      const canonId = normalizeContactId(rawContactId);
      const canonName = normalizeContactName(rawContactName) || canonId;

      // 彻底拦截 OCR 噪点，不应作为新联系人入库存盘
      if (
        isGarbageContactName(rawContactId) ||
        isGarbageContactName(rawContactName) ||
        isGarbageContactName(canonId) ||
        isGarbageContactName(canonName)
      ) {
        const dummyContact: ChannelContact = {
          id: canonId,
          channel: msg.channel,
          name: canonName,
          type: msg.isRoom ? 'room' : 'user',
          isRoom: msg.isRoom,
          autoReply: false,
          hostingMode: 'off',
        };
        const messageRecord: ChannelChatMessage = {
          id: `msg_${Date.now()}_${randomUUID().slice(0, 4)}`,
          channel: msg.channel,
          contactId: canonId,
          fromId: msg.fromId,
          fromName: msg.fromName,
          isRoom: msg.isRoom,
          sender: 'user',
          text: msg.text,
          time,
          timestamp: Date.now(),
        };
        return { contact: dummyContact, messageRecord };
      }

      // 机器人模式 (非托管): 绝不将临时会话或群成员写入聊天托管好友库，亦不继承分身人设
      if (msg.isHosting === false) {
        const botContact: ChannelContact = {
          id: canonId,
          channel: msg.channel,
          name: canonName,
          type: msg.isRoom ? 'room' : 'user',
          isRoom: msg.isRoom,
          agentId: msg.defaultAgent || 'coder',
          autoReply: true,
          replyMode: msg.isRoom ? 'mention' : 'all',
          hostingMode: 'off',
        };
        const messageRecord: ChannelChatMessage = {
          id: `${msg.channel}_bot_msg_${Date.now()}_${randomUUID().slice(0, 4)}`,
          channel: msg.channel,
          contactId: canonId,
          fromId: msg.fromId,
          fromName: msg.fromName,
          isRoom: msg.isRoom,
          roomName: msg.roomName,
          sender: 'user',
          text: msg.text,
          time,
          timestamp: Date.now(),
        };
        return { contact: botContact, messageRecord };
      }

      const def = this.getDefaultPolicy(msg.channel);
      const initialAliases = canonId !== rawContactId ? [rawContactId] : undefined;

      contact = {
        id: canonId,
        channel: msg.channel,
        name: canonName,
        type: msg.isRoom ? 'room' : 'user',
        isRoom: msg.isRoom,
        agentId: def.agentId,
        systemPrompt: def.systemPrompt,
        autoReply: def.hostingMode ? def.hostingMode !== 'off' : true,
        replyMode: msg.isRoom ? 'mention' : 'all',
        hostingMode: def.hostingMode ?? (msg.isRoom ? 'mention' : 'auto'),
        cooldownMinutes: def.cooldownMinutes ?? 10,
        delayMs: def.delayMs ?? 2500,
        lastMessage: msg.text,
        lastSender: msg.fromName,
        lastTime: time,
        unreadCount: 1,
        aliases: initialAliases,
      };
      data.contacts.unshift(contact);
    } else {
      if (rawContactId !== contact.id) {
        const aliasSet = new Set(contact.aliases || []);
        aliasSet.add(rawContactId);
        contact.aliases = Array.from(aliasSet);
      }
      contact.lastMessage = msg.text;
      contact.lastSender = msg.fromName;
      contact.lastTime = time;
      contact.unreadCount = (contact.unreadCount || 0) + 1;
    }

    const messageRecord: ChannelChatMessage = {
      id: `${msg.channel}_msg_${Date.now()}_${randomUUID().slice(0, 4)}`,
      channel: msg.channel,
      contactId: contact.id,
      fromId: msg.fromId,
      fromName: msg.fromName,
      isRoom: msg.isRoom,
      roomName: msg.roomName,
      sender: 'user',
      text: msg.text,
      time,
      timestamp: Date.now(),
    };

    data.messages.push(messageRecord);
    if (data.messages.length > 1000) {
      data.messages = data.messages.slice(-1000);
    }

    this.save(data);
    return { contact, messageRecord };
  }

  recordOutgoingMessage(msg: {
    channel: ChannelName;
    contactId: string;
    agentId?: string | undefined;
    sender?: 'agent' | 'human' | 'system';
    text: string;
    isDraft?: boolean | undefined;
    draftStatus?: 'pending' | 'sent' | 'discarded' | undefined;
    elapsedMs?: number | undefined;
  }): ChannelChatMessage {
    const data = this.load();
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const contact = this.findContact(msg.contactId, msg.channel);
    const resolvedContactId = contact ? contact.id : normalizeContactId(msg.contactId);
    const sender = msg.sender || 'agent';
    const isHuman = sender === 'human';

    if (contact) {
      contact.lastMessage = msg.text.slice(0, 80);
      contact.lastSender = isHuman ? '我 (人工回复)' : `AI (${msg.agentId || 'coder'})`;
      contact.lastTime = time;
      contact.unreadCount = 0;
    }

    const messageRecord: ChannelChatMessage = {
      id: `${msg.channel}_msg_${Date.now()}_${randomUUID().slice(0, 4)}`,
      channel: msg.channel,
      contactId: resolvedContactId,
      fromId: isHuman ? 'user_human' : 'hap_agent',
      fromName: isHuman ? '我 (人工回复)' : `AI (${msg.agentId || 'coder'})`,
      isRoom: contact ? contact.isRoom : false,
      sender,
      agentId: isHuman ? undefined : (msg.agentId || 'coder'),
      text: msg.text,
      time,
      timestamp: Date.now(),
      isDraft: msg.isDraft,
      draftStatus: msg.draftStatus,
      elapsedMs: msg.elapsedMs,
    };

    data.messages.push(messageRecord);
    if (data.messages.length > 1000) {
      data.messages = data.messages.slice(-1000);
    }

    this.save(data);
    return messageRecord;
  }

  triggerHumanTakeover(id: string, channel: ChannelName, cooldownMinutes: number = 10): ChannelContact | undefined {
    const data = this.load();
    const contact = this.findContact(id, channel);
    if (!contact) return undefined;
    contact.humanTakenOver = true;
    contact.cooldownMinutes = cooldownMinutes;
    contact.cooldownUntil = Date.now() + cooldownMinutes * 60 * 1000;
    const idx = data.contacts.findIndex((c) => c.id === contact.id && c.channel === channel);
    if (idx >= 0) data.contacts[idx] = contact;
    this.save(data);
    return contact;
  }

  releaseHumanTakeover(id: string, channel: ChannelName): ChannelContact | undefined {
    const data = this.load();
    const contact = this.findContact(id, channel);
    if (!contact) return undefined;
    contact.humanTakenOver = false;
    contact.cooldownUntil = undefined;
    const idx = data.contacts.findIndex((c) => c.id === contact.id && c.channel === channel);
    if (idx >= 0) data.contacts[idx] = contact;
    this.save(data);
    return contact;
  }

  approveDraft(messageId: string): ChannelChatMessage | undefined {
    const data = this.load();
    const msg = data.messages.find((m) => m.id === messageId && m.isDraft);
    if (!msg) return undefined;
    msg.isDraft = false;
    msg.draftStatus = 'sent';
    this.save(data);
    return msg;
  }

  discardDraft(messageId: string): boolean {
    const data = this.load();
    const msg = data.messages.find((m) => m.id === messageId && m.isDraft);
    if (!msg) return false;
    msg.isDraft = false;
    msg.draftStatus = 'discarded';
    data.messages = data.messages.filter((m) => m.id !== messageId);
    this.save(data);
    return true;
  }

  getHostingStats(): {
    totalContacts: number;
    autoReplyCount: number;
    pendingDrafts: number;
    activeCooldowned: number;
  } {
    const data = this.load();
    const now = Date.now();
    const totalContacts = data.contacts.length;
    const autoReplyCount = data.messages.filter((m) => m.sender === 'agent' && !m.isDraft).length;
    const pendingDrafts = data.messages.filter((m) => m.isDraft && m.draftStatus === 'pending').length;
    const activeCooldowned = data.contacts.filter((c) => (c.cooldownUntil && c.cooldownUntil > now) || c.humanTakenOver).length;
    return {
      totalContacts,
      autoReplyCount,
      pendingDrafts,
      activeCooldowned,
    };
  }

  getMessages(contactId?: string, channel?: ChannelName, limit: number = 100): ChannelChatMessage[] {
    const data = this.load();
    let list = data.messages;
    if (channel) {
      list = list.filter((m) => m.channel === channel);
    }
    if (contactId) {
      const contact = this.findContact(contactId, channel);
      const targetIds = new Set<string>([contactId]);
      if (contact) {
        targetIds.add(contact.id);
        if (contact.aliases) {
          for (const a of contact.aliases) targetIds.add(a);
        }
      }
      list = list.filter((m) => targetIds.has(m.contactId));
    }
    return list.slice(-limit);
  }

  /**
   * 提取纯净对话历史，转换为标准 AgentMessage[] 格式供大模型多轮推理
   */
  getRecentConversationHistory(contactId: string, channel: ChannelName = 'wechat', limit: number = 15): AgentMessage[] {
    const contact = this.findContact(contactId, channel);
    const targetIds = new Set<string>([contactId]);
    if (contact) {
      targetIds.add(contact.id);
      if (contact.aliases) {
        for (const a of contact.aliases) targetIds.add(a);
      }
    }

    const data = this.load();
    const rawMessages = data.messages.filter((m) => m.channel === channel && targetIds.has(m.contactId));

    const valid = rawMessages.filter((m) => {
      if (m.isDraft) return false;
      if (m.sender === 'system') return false;
      if (!m.text || m.text.trim().length === 0) return false;
      if (isErrorMessage(m.text)) return false;
      return true;
    });

    const recent = valid.slice(-limit);
    const result: AgentMessage[] = [];

    for (const msg of recent) {
      const role: MessageRole = msg.sender === 'user' ? 'user' : 'assistant';
      let cleanContent = msg.text.trim();
      // 剥离可能残留在历史中的人设指令模板（修复历史污染）
      if (cleanContent.includes('对方发来：“')) {
        const parts = cleanContent.split('对方发来：“');
        const candidate = parts[parts.length - 1];
        if (candidate) {
          cleanContent = candidate.replace(/”$/, '').trim();
        }
      }

      result.push({
        role,
        content: cleanContent,
        createdAt: new Date(msg.timestamp || Date.now()).toISOString(),
      });
    }

    return result;
  }

  appendContactFact(contactId: string, channel: ChannelName, fact: string): boolean {
    const trimmed = fact.trim();
    if (!trimmed) return false;
    const data = this.load();
    const contact = this.findContact(contactId, channel);
    if (!contact) return false;

    const currentFacts = contact.facts || [];
    if (currentFacts.includes(trimmed)) return false;

    contact.facts = [...currentFacts, trimmed];
    const idx = data.contacts.findIndex((c) => c.id === contact.id && c.channel === contact.channel);
    if (idx >= 0) {
      data.contacts[idx] = contact;
    }
    this.save(data);
    return true;
  }

  updateContactFacts(contactId: string, channel: ChannelName, facts: string[]): boolean {
    const data = this.load();
    const contact = this.findContact(contactId, channel);
    if (!contact) return false;

    contact.facts = facts.map((f) => f.trim()).filter(Boolean);
    const idx = data.contacts.findIndex((c) => c.id === contact.id && c.channel === contact.channel);
    if (idx >= 0) {
      data.contacts[idx] = contact;
    }
    this.save(data);
    return true;
  }

  extractContactFacts(contactId: string, channel: ChannelName, userText: string): string[] {
    const text = userText.trim();
    if (!text || text.length < 4 || text.length > 100) return [];

    const extracted: string[] = [];

    const locationMatch = /(?:我(?:现在|目前)?在|常驻|坐标)([\u4e00-\u9fa5]{2,10}(?:市|省|区|县)?)/.exec(text);
    if (locationMatch?.[1] && !['这里', '那边', '家', '路上', '公司', '开会'].includes(locationMatch[1])) {
      extracted.push(`所在地/常驻: ${locationMatch[1]}`);
    }

    const jobMatch = /(?:我是做|我从事|我们在做)([\u4e00-\u9fa5a-zA-Z0-9]{2,15})/.exec(text);
    if (jobMatch?.[1]) {
      const job = jobMatch[1].replace(/[的了地啊吧呀\s]+$/g, '').trim();
      if (job.length >= 2) {
        extracted.push(`行业/业务: ${job}`);
      }
    }

    const hobbyMatch = /(?:我(?:平时|周末)?喜欢|爱好是)([\u4e00-\u9fa5a-zA-Z0-9]{2,10})/.exec(text);
    if (hobbyMatch?.[1]) {
      extracted.push(`爱好/偏好: ${hobbyMatch[1]}`);
    }

    if (extracted.length > 0) {
      for (const fact of extracted) {
        this.appendContactFact(contactId, channel, fact);
      }
    }

    return extracted;
  }

  removeContact(id: string, channel?: ChannelName): boolean {
    const data = this.load();
    const contact = this.findContact(id, channel);
    const targetIds = new Set<string>([id]);
    if (contact) {
      targetIds.add(contact.id);
      if (contact.aliases) {
        for (const a of contact.aliases) targetIds.add(a);
      }
    }
    const initialLen = data.contacts.length;
    data.contacts = data.contacts.filter((c) => !(targetIds.has(c.id) && (!channel || c.channel === channel)));
    if (data.contacts.length !== initialLen) {
      data.messages = data.messages.filter((m) => !(targetIds.has(m.contactId) && (!channel || m.channel === channel)));
      this.save(data);
      return true;
    }
    return false;
  }

  clearAllContacts(channel?: ChannelName): void {
    const data = this.load();
    if (channel) {
      data.contacts = data.contacts.filter((c) => c.channel !== channel);
      data.messages = data.messages.filter((m) => m.channel !== channel);
    } else {
      data.contacts = [];
      data.messages = [];
    }
    this.save(data);
  }
}
