import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayStore } from '../src/gateway/store.js';
import { GatewayService } from '../src/gateway/service.js';
import { GatewayRouter } from '../src/gateway/router.js';

describe('API Distribution Gateway', () => {
  let testStorePath: string;

  beforeEach(() => {
    testStorePath = join(tmpdir(), `hap-test-gateway-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    if (existsSync(testStorePath)) {
      rmSync(testStorePath, { force: true });
    }
  });

  describe('GatewayStore', () => {
    it('initializes with default config, aliases and an initial key', () => {
      const store = new GatewayStore(testStorePath);
      const config = store.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.bind).toBe('127.0.0.1');

      const keys = store.listKeys();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys[0]?.key.startsWith('hap-')).toBe(true);

      const aliases = store.listAliases();
      expect(aliases.length).toBeGreaterThanOrEqual(2);
      expect(aliases.some(a => a.alias === 'gpt-4o')).toBe(true);
    });

    it('creates, validates and updates an API Key', () => {
      const store = new GatewayStore(testStorePath);
      const key = store.createKey({
        name: 'Cursor Key',
        allowedModels: ['qwen2.5-coder:7b', 'deepseek-chat'],
        rateLimitRpm: 120,
      });

      expect(key.name).toBe('Cursor Key');
      expect(key.allowedModels).toEqual(['qwen2.5-coder:7b', 'deepseek-chat']);
      expect(key.rateLimitRpm).toBe(120);

      // Validate key with Bearer prefix
      const validRes = store.validateKey(`Bearer ${key.key}`);
      expect(validRes.valid).toBe(true);
      expect(validRes.key?.id).toBe(key.id);

      // Validate with invalid key
      const invalidRes = store.validateKey('Bearer invalid-key');
      expect(invalidRes.valid).toBe(false);

      // Disable key
      store.updateKey(key.id, { enabled: false });
      const disabledRes = store.validateKey(`Bearer ${key.key}`);
      expect(disabledRes.valid).toBe(false);
      expect(disabledRes.error).toContain('已');
    });

    it('manages model aliases and resolves target model properly', () => {
      const store = new GatewayStore(testStorePath);

      store.upsertAlias({
        alias: 'claude-3-5-sonnet',
        targetModel: 'deepseek/deepseek-chat',
        enabled: true,
      });

      const res = store.resolveModel('claude-3-5-sonnet');
      expect(res.wasAliased).toBe(true);
      expect(res.resolvedModel).toBe('deepseek/deepseek-chat');

      // Unaliased model
      const unaliased = store.resolveModel('unknown-model-xyz');
      expect(unaliased.wasAliased).toBe(false);
      expect(unaliased.resolvedModel).toBe('unknown-model-xyz');
    });

    it('logs requests and aggregates stats correctly', () => {
      const store = new GatewayStore(testStorePath);
      const initialKey = store.listKeys()[0]!;

      store.logRequest({
        clientIp: '127.0.0.1',
        keyId: initialKey.id,
        keyName: initialKey.name,
        requestedModel: 'gpt-4o',
        targetModel: 'qwen2.5-coder:7b',
        status: 200,
        latencyMs: 150,
        promptTokens: 50,
        completionTokens: 100,
        totalTokens: 150,
        stream: false,
      });

      const logs = store.listLogs();
      expect(logs.length).toBe(1);
      expect(logs[0]?.requestedModel).toBe('gpt-4o');
      expect(logs[0]?.totalTokens).toBe(150);

      const stats = store.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalTokens).toBe(150);
      expect(stats.modelDistribution['gpt-4o']).toBe(1);
    });

    it('enforces rate limiting (RPM)', () => {
      const store = new GatewayStore(testStorePath);
      const key = store.createKey({ name: 'Limited Key', rateLimitRpm: 2 });

      expect(store.checkRateLimit(key.id, 2)).toBe(true);
      expect(store.checkRateLimit(key.id, 2)).toBe(true);
      // Third request in same minute should be rate-limited
      expect(store.checkRateLimit(key.id, 2)).toBe(false);
    });
  });

  describe('GatewayRouter', () => {
    it('identifies local Ollama model vs cloud provider model', () => {
      const store = new GatewayStore(testStorePath);
      const router = new GatewayRouter(store);

      const local1 = router.resolveBackendTarget('qwen2.5-coder:7b');
      expect(local1.kind).toBe('ollama');
      expect(local1.model).toBe('qwen2.5-coder:7b');

      const local2 = router.resolveBackendTarget('ollama/llama3.1:8b');
      expect(local2.kind).toBe('ollama');
      expect(local2.model).toBe('llama3.1:8b');

      const cloud = router.resolveBackendTarget('deepseek/deepseek-chat');
      expect(cloud.kind).toBe('openai-compatible');
      expect(cloud.providerId).toBe('deepseek');
      expect(cloud.model).toBe('deepseek-chat');
    });
  });

  describe('GatewayService', () => {
    it('provides complete client presets for Cursor, Continue, etc.', () => {
      const service = new GatewayService(testStorePath);
      const presets = service.getClientPresets(3000);

      expect(presets.length).toBeGreaterThanOrEqual(4);
      expect(presets.some(p => p.id === 'cursor')).toBe(true);
      expect(presets.some(p => p.id === 'vscode-continue')).toBe(true);
      expect(presets.some(p => p.id === 'python-openai')).toBe(true);

      const overview = service.getOverview(3000);
      expect(overview.localBaseUrl).toBe('http://127.0.0.1:3000/v1');
      expect(overview.activeKeysCount).toBeGreaterThanOrEqual(1);
    });
  });
});
