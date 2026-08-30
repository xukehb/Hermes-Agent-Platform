import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BotAuthorizationService,
  ControlPlaneStore,
  BotCredentialStore,
  type BotAccount,
  type BotPlatform,
  type ServerBotBinding,
} from '../control-plane/index.js';
import type { GuiBotInstance, GuiBotPlatform } from './shared.js';

export interface BotControlFacadeOptions {
  dbPath: string;
  credentialsDir: string;
  now?: () => Date;
}

type SupportedGuiBotPlatform = Extract<GuiBotPlatform, 'telegram' | 'feishu' | 'wechat'>;

export interface BotRuntimeDescriptor {
  account: BotAccount;
  binding: ServerBotBinding;
  credentials: Record<string, string>;
  authorization: BotAuthorizationService;
}

const secretFields = new Set(['token', 'appSecret', 'puppetToken', 'accessToken', 'secret']);

export class BotControlFacade {
  private readonly store: ControlPlaneStore;
  private readonly credentials: BotCredentialStore;
  private readonly metadataDir: string;

  constructor(options: BotControlFacadeOptions) {
    this.store = new ControlPlaneStore(options.dbPath);
    this.credentials = new BotCredentialStore(options.credentialsDir);
    this.metadataDir = join(options.credentialsDir, '..', 'bot-metadata');
  }

  close(): void {
    this.store.close();
  }

  listBots(): GuiBotInstance[] {
    const bindings = new Map(this.store.listBindings().map((binding) => [binding.botAccountId, binding]));
    return this.store.listAccounts().map((account) => {
      const binding = bindings.get(account.id);
      const summary = this.credentials.summary(account.credentialRef);
      return {
        id: account.id,
        name: account.name,
        platform: fromControlPlatform(account.platform),
        enabled: account.enabled,
        boundServerId: binding?.serverId,
        defaultAgent: account.defaultAgentId,
        status: 'stopped',
        config: {
          ...this.readMetadata(account.id),
          credentialsConfigured: summary.configured,
        },
      };
    });
  }

  upsertBot(bot: GuiBotInstance): { ok: boolean; bot: GuiBotInstance } {
    const platform = assertSupportedPlatform(bot.platform);
    const account = this.store.upsertAccount({
      id: bot.id,
      platform: toControlPlatform(platform),
      name: bot.name,
      enabled: bot.enabled,
      credentialRef: bot.id,
      transport: transportFor(platform),
      defaultAgentId: bot.defaultAgent || 'ops',
    });

    const credentials = extractCredentials(platform, bot.config ?? {});
    if (Object.keys(credentials).length > 0) {
      this.credentials.write(account.credentialRef, credentials);
    }
    this.writeMetadata(bot.id, extractMetadata(bot.config ?? {}));

    if (bot.boundServerId !== undefined && bot.boundServerId.trim() !== '') {
      const existing = this.store.bindingForAccount(bot.id);
      const input = {
        id: `bind-${bot.id}`.slice(0, 64),
        serverId: bot.boundServerId,
        botAccountId: bot.id,
        capabilityProfile: 'operate',
        approvalPolicy: 'dangerous_local',
        alertPolicy: {},
      } as const;
      if (existing === undefined) this.store.bind(input);
      else this.store.replaceBinding(bot.boundServerId, input);
    }

    return { ok: true, bot: this.botById(bot.id)! };
  }

  deleteBot(id: string): { ok: boolean } {
    this.store.deleteAccount(id);
    return { ok: true };
  }

  toggleBotStatus(id: string, enabled: boolean): { ok: boolean; message: string; bot?: GuiBotInstance } {
    const account = this.store.setAccountEnabled(id, enabled);
    const bot = this.botById(account.id);
    return {
      ok: true,
      message: enabled ? `机器人 [${account.name}] 已标记为启用，运行时将在下一次启动时连接` : `机器人 [${account.name}] 已停止`,
      ...(bot === undefined ? {} : { bot }),
    };
  }

  runtimeBots(platform?: SupportedGuiBotPlatform): BotRuntimeDescriptor[] {
    const bindings = new Map(this.store.listBindings().map((binding) => [binding.botAccountId, binding]));
    const controlPlatform = platform === undefined ? undefined : toControlPlatform(platform);
    return this.store.listAccounts()
      .filter((account) => account.enabled)
      .filter((account) => controlPlatform === undefined || account.platform === controlPlatform)
      .flatMap((account) => {
        const binding = bindings.get(account.id);
        const credentials = this.credentials.read(account.credentialRef);
        if (binding === undefined || credentials === undefined) return [];
        return [{
          account,
          binding,
          credentials,
          authorization: new BotAuthorizationService(this.store),
        }];
      });
  }

  accountForTest(id: string): BotAccount | undefined {
    return this.store.account(id);
  }

  readCredentialsForTest(id: string): Record<string, string> | undefined {
    return this.credentials.read(id);
  }

  private botById(id: string): GuiBotInstance | undefined {
    return this.listBots().find((bot) => bot.id === id);
  }

  private metadataPath(id: string): string {
    return join(this.metadataDir, `${id}.json`);
  }

  private readMetadata(id: string): Partial<GuiBotInstance['config']> {
    const path = this.metadataPath(id);
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuiBotInstance['config']>;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeMetadata(id: string, metadata: Partial<GuiBotInstance['config']>): void {
    mkdirSync(this.metadataDir, { recursive: true });
    writeFileSync(this.metadataPath(id), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  }
}

function assertSupportedPlatform(platform: GuiBotPlatform): SupportedGuiBotPlatform {
  if (platform === 'telegram' || platform === 'feishu' || platform === 'wechat') return platform;
  throw new Error(`机器人平台 ${platform} 尚未接入安全控制平面，请使用 Telegram / 飞书 / 微信`);
}

function toControlPlatform(platform: SupportedGuiBotPlatform): BotPlatform {
  if (platform === 'wechat') return 'wechat_ilink';
  return platform;
}

function fromControlPlatform(platform: BotPlatform): SupportedGuiBotPlatform {
  if (platform === 'wechat_ilink') return 'wechat';
  return platform;
}

function transportFor(platform: SupportedGuiBotPlatform): 'ilink' | 'polling' | 'webhook' {
  if (platform === 'wechat') return 'ilink';
  if (platform === 'telegram') return 'polling';
  return 'webhook';
}

function extractCredentials(platform: SupportedGuiBotPlatform, config: GuiBotInstance['config']): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!secretFields.has(key) || typeof value !== 'string' || value.trim() === '') continue;
    if (platform === 'telegram' && key === 'token') credentials.token = value.trim();
    if (platform === 'feishu' && key === 'appSecret') credentials.appSecret = value.trim();
    if (platform === 'wechat' && key === 'puppetToken') credentials.botToken = value.trim();
  }
  return credentials;
}

function extractMetadata(config: GuiBotInstance['config']): Partial<GuiBotInstance['config']> {
  const metadata: Partial<GuiBotInstance['config']> = {};
  if (Array.isArray(config.adminUsers)) metadata.adminUsers = config.adminUsers;
  if (typeof config.appId === 'string' && config.appId.trim() !== '') metadata.appId = config.appId.trim();
  if (typeof config.botName === 'string' && config.botName.trim() !== '') metadata.botName = config.botName.trim();
  if (typeof config.webhookUrl === 'string' && config.webhookUrl.trim() !== '') metadata.webhookUrl = config.webhookUrl.trim();
  if (typeof config.wsEndpoint === 'string' && config.wsEndpoint.trim() !== '') metadata.wsEndpoint = config.wsEndpoint.trim();
  return metadata;
}
