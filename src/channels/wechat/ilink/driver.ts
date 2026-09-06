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
  private loginSession: IlinkLoginSession | undefined;
  private generation = 0;
  private authenticated = false;
  private cancelStart: (() => void) | undefined;

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
    const generation = ++this.generation;
    await new Promise<void>((resolve, reject) => {
      this.cancelStart = resolve;
      // Return once the QR is available so the GUI can display it while polling continues.
      void (async () => {
        let account = this.store.loadAccount();
        if (account === undefined) {
          await this.login(generation, resolve);
          account = this.store.loadAccount();
        } else {
          this.api = this.apiFactory({ token: account.botToken, baseUrl: account.baseUrl });
        }
        if (!this.running || generation !== this.generation) return;
        await this.api.notifyStart();
        if (!this.running || generation !== this.generation) return;
        this.authenticated = true;
        if (account) this.onLogin?.({ id: account.ilinkBotId, name: 'WeChat iLink Bot' });
        this.loop = this.pollLoop(generation);
        resolve();
      })().catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.running = false;
        this.onLogout?.(error instanceof Error ? error.message : String(error));
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    this.loginSession?.stop();
    this.cancelStart?.();
    if (this.authenticated) await this.api.notifyStop();
    this.authenticated = false;
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

  private async login(generation: number, ready: () => void): Promise<void> {
    let lastState: LoginState = { phase: 'idle' };
    const login = new IlinkLoginSession({
      api: this.api,
      store: this.store,
      pollIntervalMs: this.pollIntervalMs,
      onState: (state) => {
        lastState = state;
        this.handleLoginState(state);
        if (state.phase === 'qr_ready') ready();
      },
    });
    this.loginSession = login;
    await login.start();
    if (!this.running || generation !== this.generation) return;
    const account = this.store.loadAccount();
    if (account === undefined) {
      const state = lastState as LoginState;
      const messages: Partial<Record<LoginState['phase'], string>> = {
        expired: '微信二维码已过期，请刷新二维码后重新扫码',
        verification_required: '微信要求额外验证码验证，当前客户端尚不支持，请重新扫码或更换绑定方式',
        verification_blocked: '微信验证暂时受限，请稍后重新扫码',
        redirect: '微信登录需要跳转其他服务，请重新扫码或检查账号绑定',
        already_bound: '微信机器人已绑定，请检查现有绑定后重新扫码',
      };
      throw new Error(state.phase === 'error' ? state.code : messages[state.phase] ?? '微信登录未完成，请重新扫码');
    }
    this.api = this.apiFactory({ token: account.botToken, baseUrl: account.baseUrl });
  }

  private handleLoginState(state: LoginState): void {
    switch (state.phase) {
      case 'qr_ready':
        this.onQrCode?.(state.qrText);
        break;
      case 'connected':
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

  private async pollLoop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
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
