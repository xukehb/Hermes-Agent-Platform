import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChannelName } from './types.js';

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
const LEGACY_WECHAT_PATH = join(homedir(), '.hap', 'wechat_contacts.json');

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const DEFAULT_SEEDED_CONTACTS: ChannelContact[] = [];

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
      return {
        contacts: realContacts,
        messages: messages.filter((m) => realContacts.some((c) => c.id === m.contactId)),
        defaults,
      };
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
    return this.listContacts(channel).find((c) => c.id === id);
  }

  upsertContact(input: Partial<ChannelContact> & { id: string; channel: ChannelName; name: string }): ChannelContact {
    const data = this.load();
    const existingIdx = data.contacts.findIndex((c) => c.id === input.id && c.channel === input.channel);
    const existing = existingIdx >= 0 ? data.contacts[existingIdx] : undefined;

    const contact: ChannelContact = {
      id: input.id,
      channel: input.channel,
      name: input.name.trim(),
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
    const contactId = msg.isRoom && msg.roomId ? msg.roomId : msg.fromId;
    const contactName = msg.isRoom ? (msg.roomName || `群聊 (${contactId})`) : (msg.fromName || `用户 (${contactId})`);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let contact = data.contacts.find((c) => c.id === contactId && c.channel === msg.channel);
    if (!contact) {
      const def = this.getDefaultPolicy(msg.channel);
      contact = {
        id: contactId,
        channel: msg.channel,
        name: contactName,
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
      };
      data.contacts.unshift(contact);
    } else {
      contact.name = contactName;
      contact.lastMessage = msg.text;
      contact.lastSender = msg.fromName;
      contact.lastTime = time;
      contact.unreadCount = (contact.unreadCount || 0) + 1;
    }

    const messageRecord: ChannelChatMessage = {
      id: `${msg.channel}_msg_${Date.now()}_${randomUUID().slice(0, 4)}`,
      channel: msg.channel,
      contactId,
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
    const contact = data.contacts.find((c) => c.id === msg.contactId && c.channel === msg.channel);
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
      contactId: msg.contactId,
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
    const contact = data.contacts.find((c) => c.id === id && c.channel === channel);
    if (!contact) return undefined;
    contact.humanTakenOver = true;
    contact.cooldownMinutes = cooldownMinutes;
    contact.cooldownUntil = Date.now() + cooldownMinutes * 60 * 1000;
    this.save(data);
    return contact;
  }

  releaseHumanTakeover(id: string, channel: ChannelName): ChannelContact | undefined {
    const data = this.load();
    const contact = data.contacts.find((c) => c.id === id && c.channel === channel);
    if (!contact) return undefined;
    contact.humanTakenOver = false;
    contact.cooldownUntil = undefined;
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
      list = list.filter((m) => m.contactId === contactId);
    }
    return list.slice(-limit);
  }

  removeContact(id: string, channel?: ChannelName): boolean {
    const data = this.load();
    const initialLen = data.contacts.length;
    data.contacts = data.contacts.filter((c) => !(c.id === id && (!channel || c.channel === channel)));
    if (data.contacts.length !== initialLen) {
      data.messages = data.messages.filter((m) => !(m.contactId === id && (!channel || m.channel === channel)));
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

