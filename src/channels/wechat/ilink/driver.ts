import { IlinkApiClient } from './api-client.js';
import { IlinkAccountStore } from './credential-store.js';
import { IlinkLoginSession, type LoginState } from './login-session.js';
import type { ChannelAttachments } from '../../types.js';

export interface NativeIlinkDriverOptions {
  accountId: string;
  rootDir: string;
  pollIntervalMs?: number;
  apiFactory?: (account?: { token: string; baseUrl: string }) => Pick<IlinkApiClient, 'createQr' | 'qrStatus' | 'notifyStart' | 'notifyStop' | 'getUpdates' | 'sendText'>;
  log?: (line: string) => void;
}

export class NativeIlinkPersonalDriver {
  onQrCode?: (qrText: string, dataUrl?: string) => void;
  onLogin?: (user: { id: string; name: string }) => void;
  onLogout?: (reason?: string) => void;
  onMessage?: (msg: {
    id: string;
    fromId: string;
    fromName: string;
    isRoom: boolean;
    roomId?: string;
    roomName?: string;
    text: string;
    attachments?: ChannelAttachments;
  }) => Promise<void> | void;

  private readonly store: IlinkAccountStore;
  private readonly pollIntervalMs: number;
  private readonly apiFactory: NonNullable<NativeIlinkDriverOptions['apiFactory']>;
  private readonly log: (line: string) => void;
  private api: Pick<IlinkApiClient, 'createQr' | 'qrStatus' | 'notifyStart' | 'notifyStop' | 'getUpdates' | 'sendText'>;
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(options: NativeIlinkDriverOptions) {
    this.store = new IlinkAccountStore(options.rootDir, options.accountId);
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
    this.log = options.log ?? (() => undefined);
    this.apiFactory = options.apiFactory ?? ((account) => new IlinkApiClient({
      ...(account?.token === undefined ? {} : { token: account.token }),
      ...(account?.baseUrl === undefined ? {} : { baseUrl: account.baseUrl }),
    }));
    const account = this.store.loadAccount();
    this.api = this.apiFactory(account === undefined ? undefined : { token: account.botToken, baseUrl: account.baseUrl });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const account = this.store.loadAccount();
    if (account === undefined) {
      await this.login();
    } else {
      this.api = this.apiFactory({ token: account.botToken, baseUrl: account.baseUrl });
      this.onLogin?.({ id: account.ilinkBotId, name: 'WeChat iLink Bot' });
    }
    await this.api.notifyStart();
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.api.notifyStop();
    this.onLogout?.('channel_stopped');
    await this.loop;
  }

  async sendMessage(targetId: string, text: string): Promise<string | undefined> {
    const contextToken = this.store.contextFor(targetId);
    if (contextToken === undefined) throw new Error('ILINK_CONTEXT_TOKEN_MISSING');
    await this.api.sendText({ toUserId: targetId, contextToken, text });
    return 'ilink:' + Date.now().toString(36);
  }

  async pollOnceForTest(): Promise<void> {
    await this.pollOnce();
  }

  private async login(): Promise<void> {
    const login = new IlinkLoginSession({
      api: this.api,
      store: this.store,
      pollIntervalMs: this.pollIntervalMs,
      onState: (state) => this.handleLoginState(state),
    });
    await login.start();
    const account = this.store.loadAccount();
    if (account === undefined) throw new Error('ILINK_AUTH_REQUIRED');
    this.api = this.apiFactory({ token: account.botToken, baseUrl: account.baseUrl });
  }

  private handleLoginState(state: LoginState): void {
    switch (state.phase) {
      case 'qr_ready':
        this.onQrCode?.(state.qrText);
        break;
      case 'connected':
        this.onLogin?.({ id: state.ilinkBotId, name: 'WeChat iLink Bot' });
        break;
      case 'scanned':
        this.log('[WeChat iLink] QR scanned, waiting for confirmation');
        break;
      case 'verification_required':
        this.log('[WeChat iLink] verification code required');
        break;
      case 'error':
        this.log('[WeChat iLink] login error: ' + state.code);
        break;
      default:
        break;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.log('[WeChat iLink] getupdates failed: ' + (error instanceof Error ? error.message : String(error)));
      }
      if (this.pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      else return;
    }
  }

  private async pollOnce(): Promise<void> {
    const batch = await this.api.getUpdates(this.store.loadCursor());
    this.store.saveCursor(batch.cursor);
    for (const message of batch.messages) {
      if (!this.store.markInboundSeen(message.id)) continue;
      const targetId = message.groupId ?? message.fromUserId;
      if (message.contextToken !== undefined) this.store.putContext(targetId, message.contextToken);
      await this.onMessage?.({
        id: message.id,
        fromId: message.fromUserId,
        fromName: message.fromUserId,
        isRoom: message.groupId !== undefined,
        ...(message.groupId === undefined ? {} : { roomId: message.groupId, roomName: message.groupId }),
        text: message.text,
      });
    }
  }
}
