import fs from 'node:fs';
import path from 'node:path';
import { RemoteServerConfig } from './types.js';

const CONFIG_DIR = path.resolve(process.cwd(), '.codex');
const SERVERS_FILE = path.join(CONFIG_DIR, 'servers.json');

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export class RemoteServerStore {
  private static instance: RemoteServerStore;
  private filePath: string;

  constructor(customPath?: string) {
    this.filePath = customPath || SERVERS_FILE;
  }

  static getInstance(): RemoteServerStore {
    if (!RemoteServerStore.instance) {
      RemoteServerStore.instance = new RemoteServerStore();
    }
    return RemoteServerStore.instance;
  }

  list(): RemoteServerConfig[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }
      const data = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(data || '[]');
    } catch {
      return [];
    }
  }

  get(id: string): RemoteServerConfig | undefined {
    return this.list().find(s => s.id === id);
  }

  upsert(config: Partial<RemoteServerConfig> & { id: string; host: string }): RemoteServerConfig {
    ensureDir();
    const servers = this.list();
    const existingIndex = servers.findIndex(s => s.id === config.id);
    const now = Date.now();

    const existing = existingIndex >= 0 ? servers[existingIndex] : undefined;
    const fullConfig: RemoteServerConfig = {
      id: config.id,
      name: config.name || config.host,
      host: config.host,
      port: config.port || 22,
      username: config.username || 'root',
      authType: config.authType || 'password',
      password: config.password,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
      daemonPort: config.daemonPort || 9527,
      token: config.token,
      agentId: config.agentId || (existing?.agentId || 'ops'),
      boundBotId: config.boundBotId ?? existing?.boundBotId,
      botConfig: config.botConfig ?? existing?.botConfig,
      status: config.status || 'uninstalled',
      lastConnectedAt: config.lastConnectedAt,
      lastError: config.lastError,
      systemInfo: config.systemInfo,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    if (existingIndex >= 0 && existing) {
      servers[existingIndex] = { ...existing, ...fullConfig, updatedAt: now };
    } else {
      servers.push(fullConfig);
    }

    fs.writeFileSync(this.filePath, JSON.stringify(servers, null, 2) + '\n', 'utf-8');
    return fullConfig;
  }

  updateStatus(id: string, updates: Partial<RemoteServerConfig>): RemoteServerConfig | undefined {
    ensureDir();
    const servers = this.list();
    const index = servers.findIndex(s => s.id === id);
    if (index === -1) return undefined;
    const target = servers[index];
    if (!target) return undefined;

    const updated: RemoteServerConfig = {
      ...target,
      ...updates,
      id: target.id,
      updatedAt: Date.now(),
    };
    servers[index] = updated;

    fs.writeFileSync(this.filePath, JSON.stringify(servers, null, 2) + '\n', 'utf-8');
    return updated;
  }

  remove(id: string): boolean {
    ensureDir();
    const servers = this.list();
    const filtered = servers.filter(s => s.id !== id);
    if (filtered.length !== servers.length) {
      fs.writeFileSync(this.filePath, JSON.stringify(filtered, null, 2) + '\n', 'utf-8');
      return true;
    }
    return false;
  }
}
