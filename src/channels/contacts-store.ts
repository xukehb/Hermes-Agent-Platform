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
  sender: 'user' | 'agent' | 'system';
  agentId?: string | undefined;
  text: string;
  time: string;
  timestamp: number;
}

interface ChannelContactStoreData {
  contacts: ChannelContact[];
  messages: ChannelChatMessage[];
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
      const initial: ChannelContactStoreData = { contacts: [], messages: [] };
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
      return {
        contacts: realContacts,
        messages: messages.filter((m) => realContacts.some((c) => c.id === m.contactId)),
      };
    } catch {
      return { contacts: [], messages: [] };
    }
  }

  save(data: ChannelContactStoreData): void {
    ensureDir(this.filePath);
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
      contact = {
        id: contactId,
        channel: msg.channel,
        name: contactName,
        type: msg.isRoom ? 'room' : 'user',
        isRoom: msg.isRoom,
        agentId: 'coder',
        autoReply: true,
        replyMode: msg.isRoom ? 'mention' : 'all',
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
    text: string;
  }): ChannelChatMessage {
    const data = this.load();
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const contact = data.contacts.find((c) => c.id === msg.contactId && c.channel === msg.channel);
    if (contact) {
      contact.lastMessage = msg.text.slice(0, 80);
      contact.lastSender = `AI (${msg.agentId || 'coder'})`;
      contact.lastTime = time;
      contact.unreadCount = 0;
    }

    const messageRecord: ChannelChatMessage = {
      id: `${msg.channel}_msg_${Date.now()}_${randomUUID().slice(0, 4)}`,
      channel: msg.channel,
      contactId: msg.contactId,
      fromId: 'hap_agent',
      fromName: `AI (${msg.agentId || 'coder'})`,
      isRoom: contact ? contact.isRoom : false,
      sender: 'agent',
      agentId: msg.agentId || 'coder',
      text: msg.text,
      time,
      timestamp: Date.now(),
    };

    data.messages.push(messageRecord);
    if (data.messages.length > 1000) {
      data.messages = data.messages.slice(-1000);
    }

    this.save(data);
    return messageRecord;
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
}
