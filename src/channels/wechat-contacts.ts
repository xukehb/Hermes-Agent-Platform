import { ChannelContactStore, type ChannelContact, type ChannelChatMessage, type ChannelDefaultPolicy } from './contacts-store.js';

export type WeChatContact = ChannelContact;
export type WeChatChatMessage = ChannelChatMessage;
export type WeChatDefaultPolicy = ChannelDefaultPolicy;

export class WeChatContactStore {
  private static instance: WeChatContactStore;
  private readonly store: ChannelContactStore;

  constructor(filePath?: string) {
    this.store = filePath ? new ChannelContactStore(filePath) : ChannelContactStore.getInstance();
  }

  static getInstance(filePath?: string): WeChatContactStore {
    if (!WeChatContactStore.instance) {
      WeChatContactStore.instance = new WeChatContactStore(filePath);
    }
    return WeChatContactStore.instance;
  }

  static resetInstance(): void {
    WeChatContactStore.instance = undefined as unknown as WeChatContactStore;
  }

  listContacts(): WeChatContact[] {
    return this.store.listContacts('wechat');
  }

  getContact(id: string): WeChatContact | undefined {
    return this.store.getContact(id, 'wechat');
  }

  upsertContact(input: Partial<WeChatContact> & { id: string; name: string }): WeChatContact {
    return this.store.upsertContact({
      ...input,
      channel: 'wechat',
    });
  }

  upsertRealContact(input: { id: string; name: string; isRoom: boolean }): WeChatContact {
    const existing = this.getContact(input.id);
    return this.upsertContact({ ...existing, id: input.id, name: input.name, type: input.isRoom ? 'room' : 'user', isRoom: input.isRoom, autoReply: existing?.autoReply ?? true, replyMode: existing?.replyMode ?? (input.isRoom ? 'mention' : 'all') });
  }

  recordIncomingMessage(msg: {
    fromId: string;
    fromName: string;
    isRoom: boolean;
    roomId?: string | undefined;
    roomName?: string | undefined;
    text: string;
  }): { contact: WeChatContact; messageRecord: WeChatChatMessage } {
    return this.store.recordIncomingMessage({
      channel: 'wechat',
      ...msg,
    });
  }

  recordOutgoingMessage(msg: {
    contactId: string;
    agentId?: string | undefined;
    sender?: 'agent' | 'human' | 'system';
    text: string;
    isDraft?: boolean | undefined;
    draftStatus?: 'pending' | 'sent' | 'discarded' | undefined;
    elapsedMs?: number | undefined;
  }): WeChatChatMessage {
    return this.store.recordOutgoingMessage({
      channel: 'wechat',
      ...msg,
    });
  }

  getMessages(contactId?: string, limit: number = 100): WeChatChatMessage[] {
    return this.store.getMessages(contactId, 'wechat', limit);
  }

  removeContact(id: string): boolean {
    return this.store.removeContact(id, 'wechat');
  }

  clearAllContacts(): void {
    this.store.clearAllContacts('wechat');
  }

  getDefaultPolicy(_channel?: string): WeChatDefaultPolicy {
    return this.store.getDefaultPolicy('wechat');
  }

  saveDefaultPolicy(policy: Partial<WeChatDefaultPolicy>): WeChatDefaultPolicy {
    return this.store.saveDefaultPolicy('wechat', policy);
  }
}

