import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cosineSimilarity, dotProduct, normalizeVector } from '../src/memory/vector-math.js';
import { LocalSemanticEmbedder } from '../src/memory/embedding.js';
import { MemoryStore } from '../src/memory/store.js';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Vector Memory & RAG Engine', () => {
  describe('Vector Math', () => {
    it('calculates dot product and cosine similarity', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];
      const c = [0, 1, 0];

      expect(dotProduct(a, b)).toBe(1);
      expect(dotProduct(a, c)).toBe(0);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
      expect(cosineSimilarity(a, c)).toBeCloseTo(0.0);
    });

    it('normalizes vector to unit length', () => {
      const v = [3, 4];
      const norm = normalizeVector(v);
      expect(norm[0]).toBeCloseTo(0.6);
      expect(norm[1]).toBeCloseTo(0.8);
    });
  });

  describe('Local Semantic Embedder', () => {
    const embedder = new LocalSemanticEmbedder(64);

    it('generates consistent vectors for identical text', async () => {
      const vec1 = await embedder.embed('用户偏好 Tailwind CSS 与 React Hooks');
      const vec2 = await embedder.embed('用户偏好 Tailwind CSS 与 React Hooks');
      expect(vec1).toEqual(vec2);
      expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(1.0);
    });

    it('produces higher similarity for semantically related text than unrelated text', async () => {
      const base = await embedder.embed('前端统一使用 TypeScript 与 Tailwind 样式');
      const related = await embedder.embed('请使用 React 和 Tailwind 构建前端页面');
      const unrelated = await embedder.embed('后端配置 PostgreSQL 数据库连接池');

      const simRelated = cosineSimilarity(base, related);
      const simUnrelated = cosineSimilarity(base, unrelated);

      expect(simRelated).toBeGreaterThan(simUnrelated);
    });
  });

  describe('Memory Store & Semantic Search', () => {
    const testDb = join(tmpdir(), `test-memories-${Date.now()}.json`);
    let store: MemoryStore;

    beforeEach(() => {
      store = new MemoryStore(testDb);
    });

    afterEach(() => {
      for (const file of [testDb, `${testDb}.db`, `${testDb}.migrated`]) {
        if (existsSync(file)) {
          try { unlinkSync(file); } catch {}
        }
      }
    });

    it('adds, lists, and searches memories via vector semantic similarity', async () => {
      await store.addMemory({
        title: '前端框架规范',
        content: '所有前端组件必须基于 React 19 和 TailwindCSS 开发，禁止使用全局 style',
        category: 'preference',
        tags: ['frontend', 'react'],
      });

      await store.addMemory({
        title: 'API 错误处理规范',
        content: '所有 RESTful 接口响应必须统一包装为 Result<T> 结构并包含 code/message',
        category: 'architecture',
        tags: ['backend', 'api'],
      });

      const list = store.listMemories();
      expect(list.length).toBe(2);

      const searchRes = await store.searchMemories({
        text: '写一个 React 前端页面',
        limit: 1,
      });

      expect(searchRes.length).toBe(1);
      expect(searchRes[0]!.memory.title).toBe('前端框架规范');
      expect(searchRes[0]!.score).toBeGreaterThan(0.2);
    });

    it('preserves metadata and supports update and expiration filtering', async () => {
      const card = await store.addMemory({
        title: '项目规范',
        content: '使用 TypeScript',
        category: 'convention',
        agentId: 'coder',
        workspace: '/workspace/demo',
        importance: 0.9,
        confidence: 0.8,
        expiresAt: Date.now() - 1,
      });
      expect(card.layer).toBe('semantic');
      expect(store.listMemories()[0]?.agentId).toBe('coder');
      expect(await store.searchMemories({ text: 'TypeScript', workspace: '/workspace/demo' })).toHaveLength(0);

      const updated = store.updateMemory(card.id, { content: '必须使用 TypeScript 和 ESM', expiresAt: undefined });
      expect(updated?.content).toContain('ESM');
      expect((await store.searchMemories({ text: 'ESM', agentId: 'coder', workspace: '/workspace/demo' }))[0]?.memory.id).toBe(card.id);
    });

    it('migrates legacy JSON and rejects malformed legacy data', async () => {
      const legacy = join(tmpdir(), `legacy-memory-${Date.now()}.json`);
      writeFileSync(legacy, JSON.stringify({ memories: [{
        id: 'legacy-1', category: 'preference', title: '旧偏好', content: '使用 ESM', tags: [], createdAt: 1, updatedAt: 1, accessCount: 0,
      }] }));
      const migrated = new MemoryStore(legacy);
      expect(migrated.listMemories()[0]?.id).toBe('legacy-1');
      expect(existsSync(`${legacy}.migrated`)).toBe(true);
      migrated.close();
      for (const file of [legacy, `${legacy}.db`, `${legacy}.migrated`]) if (existsSync(file)) unlinkSync(file);

      const broken = join(tmpdir(), `broken-memory-${Date.now()}.json`);
      writeFileSync(broken, '{broken');
      expect(() => new MemoryStore(broken)).toThrow(/损坏|解析/);
      unlinkSync(broken);
    });

    it('keeps concurrent additions instead of overwriting state', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, index) => store.addMemory({
        title: `并发 ${index}`,
        content: `内容 ${index}`,
        category: 'fact',
      })));
      expect(store.listMemories()).toHaveLength(20);
    });

    it('merges highly similar memories without an explicit dedupe key', async () => {
      const first = await store.addMemory({ title: '命名规范', content: '项目统一使用 kebab-case 命名文件', category: 'convention' });
      const second = await store.addMemory({ title: '命名规范补充', content: '项目统一使用 kebab-case 命名文件', category: 'convention' });
      expect(second.id).toBe(first.id);
      expect(store.listMemories()).toHaveLength(1);
    });

    it('does not mix embeddings from an older model version into vector ranking', async () => {
      const legacy = join(tmpdir(), `legacy-embedding-${Date.now()}.json`);
      writeFileSync(legacy, JSON.stringify({ memories: [{
        id: 'old-vector', category: 'fact', title: '旧向量', content: '旧模型记录',
        embedding: new Array(64).fill(1), embeddingVersion: 'old-model-v0', tags: [], createdAt: 1, updatedAt: 1,
      }] }));
      const migrated = new MemoryStore(legacy);
      const results = await migrated.searchMemories({ text: '完全不同的查询', threshold: 0 });
      expect(results[0]?.score ?? 0).toBeLessThan(0.2);
      migrated.close();
      for (const file of [legacy, `${legacy}.db`, `${legacy}.migrated`]) if (existsSync(file)) unlinkSync(file);
    });
  });
});
