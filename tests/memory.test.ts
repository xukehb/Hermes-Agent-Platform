import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cosineSimilarity, dotProduct, normalizeVector } from '../src/memory/vector-math.js';
import { LocalSemanticEmbedder } from '../src/memory/embedding.js';
import { MemoryStore } from '../src/memory/store.js';
import { existsSync, unlinkSync } from 'node:fs';
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
      if (existsSync(testDb)) {
        try { unlinkSync(testDb); } catch {}
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
  });
});
