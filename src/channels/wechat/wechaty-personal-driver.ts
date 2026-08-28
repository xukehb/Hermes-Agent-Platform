import { WechatyBuilder } from 'wechaty';
import { PuppetService } from 'wechaty-puppet-service';
import { WeChatContactStore } from '../wechat-contacts.js';
import type { WeChatPersonalDriver } from '../wechat.js';

type Entity = { id: string; name: () => string; say?: (text: string) => Promise<void>; topic?: () => Promise<string> };

/** 基于供应商 Puppet 的个人微信驱动，不伪造登录态或联系人。 */
export class WechatyPersonalDriver implements WeChatPersonalDriver {
  private bot: any;
  constructor(private readonly options: { tokenEnv: string; endpoint?: string | undefined; env?: Record<string, string | undefined>; log: (line: string) => void }) {}
  onQrCode?: (qrText: string, dataUrl?: string) => void;
  onLogin?: (user: { id: string; name: string }) => void;
  onLogout?: (reason?: string) => void;
  onMessage?: (msg: { id: string; fromId: string; fromName: string; isRoom: boolean; roomId?: string; roomName?: string; text: string }) => Promise<void> | void;
  async start(): Promise<void> {
    const token = (this.options.env ?? process.env)[this.options.tokenEnv];
    if (!token) throw new Error(`缺少个人微信 Puppet 凭据环境变量：${this.options.tokenEnv}`);
    const puppetOptions: { token: string; endpoint?: string } = { token };
    if (this.options.endpoint) {
      puppetOptions.endpoint = this.options.endpoint;
    }
    this.bot = WechatyBuilder.build({ name: 'hap-wechat', puppet: new PuppetService(puppetOptions) });
    this.bot.on('scan', (qr: string) => this.onQrCode?.(qr));
    this.bot.on('login', async (contact: Entity) => { this.onLogin?.({ id: contact.id, name: contact.name() }); await this.syncContacts(); });
    this.bot.on('logout', (_contact: Entity, reason: string) => this.onLogout?.(reason));
    this.bot.on('message', async (message: any) => {
      if (message.self?.()) return;
      const talker: Entity | undefined = message.talker?.(); const room: Entity | undefined = message.room?.();
      if (talker) {
        const payload: { id: string; fromId: string; fromName: string; isRoom: boolean; roomId?: string; roomName?: string; text: string } = {
          id: message.id,
          fromId: talker.id,
          fromName: talker.name(),
          isRoom: !!room,
          text: message.text(),
        };
        if (room) {
          payload.roomId = room.id;
          const roomTopic = room.topic ? await room.topic() : room.name();
          if (roomTopic) payload.roomName = roomTopic;
        }
        await this.onMessage?.(payload);
      }
    });
    await this.bot.start();
  }
  async stop(): Promise<void> { await this.bot?.stop(); }
  async syncContacts(): Promise<{ contacts: number; rooms: number; syncedAt: number }> {
    if (!this.bot) throw new Error('个人微信服务尚未启动');
    const [contacts, rooms] = await Promise.all([this.bot.Contact.findAll(), this.bot.Room.findAll()]); const store = WeChatContactStore.getInstance();
    for (const c of contacts as Entity[]) store.upsertRealContact({ id: c.id, name: c.name(), isRoom: false });
    for (const r of rooms as Entity[]) store.upsertRealContact({ id: r.id, name: r.topic ? await r.topic() : r.name(), isRoom: true });
    return { contacts: contacts.length, rooms: rooms.length, syncedAt: Date.now() };
  }
  async sendMessage(targetId: string, text: string): Promise<string | undefined> {
    if (!this.bot) throw new Error('个人微信服务尚未启动');
    const target: Entity | undefined = await this.bot.Contact.find({ id: targetId }) ?? await this.bot.Room.find({ id: targetId });
    if (!target?.say) throw new Error(`未找到真实微信联系人或群聊：${targetId}`); await target.say(text); return `${targetId}:${Date.now()}`;
  }
}
