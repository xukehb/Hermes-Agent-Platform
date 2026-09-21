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

      // 重定向消息所属的 contactId
      const finalContacts = Array.from(canonicalMap.values());
      const redirectedMessages = messages
        .map((m) => {
          const redirected = idRedirectMap.get(m.contactId);
          if (redirected) {
            mutated = true;
            return { ...m, contactId: redirected };
          }
          return m;
        })
        .filter((m) => finalContacts.some((c) => c.id === m.contactId));

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
      const def = this.getDefaultPolicy(msg.channel);
      const canonId = normalizeContactId(rawContactId);
      const canonName = normalizeContactName(rawContactName) || canonId;
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
      if (m.text.includes('✗ 任务失败') || m.text.includes('（本次没有产生正文输出）')) return false;
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
