import { ChannelContactStore, type ChannelContact, type ChannelChatMessage } from './contacts-store.js';

export type WeChatContact = ChannelContact;
export type WeChatChatMessage = ChannelChatMessage;

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
    text: string;
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
}
