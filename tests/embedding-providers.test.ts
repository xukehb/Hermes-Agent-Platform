import { describe, expect, it, vi } from 'vitest';
import {
  LocalSemanticEmbedder,
  OllamaEmbeddingProvider,
  OpenAiEmbeddingProvider,
  SmartFallbackEmbeddingProvider,
  createDefaultEmbeddingProvider,
} from '../src/memory/embedding.js';

describe('Embedding Providers and Fallbacks', () => {
  it('SmartFallbackEmbeddingProvider falls back to local embedder if primary fails', async () => {
    const failingPrimary = {
      version: 'failing-primary',
      embed: vi.fn().mockRejectedValue(new Error('Connection refused')),
      embedBatch: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const fallback = new LocalSemanticEmbedder(64);
    const provider = new SmartFallbackEmbeddingProvider(failingPrimary, fallback);

    const vec = await provider.embed('测试文本');
    expect(vec).toHaveLength(64);
    expect(failingPrimary.embed).toHaveBeenCalledTimes(1);

    // Second call should directly use fallback without trying failing primary
    const vec2 = await provider.embed('第二段测试文本');
    expect(vec2).toHaveLength(64);
    expect(failingPrimary.embed).toHaveBeenCalledTimes(1);
  });

  it('OllamaEmbeddingProvider parses valid ollama embeddings API response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.3, 0.4, 0.0] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434',
      model: 'bge-m3',
    });

    expect(provider.version).toBe('ollama-bge-m3');
    const vec = await provider.embed('Hello world');
    expect(vec).toHaveLength(3);
    expect(vec[0]).toBeCloseTo(0.6);
    expect(vec[1]).toBeCloseTo(0.8);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    vi.unstubAllGlobals();
  });

  it('OpenAiEmbeddingProvider parses valid OpenAI embeddings API response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.6, 0.8] }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OpenAiEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
    });

    expect(provider.version).toBe('openai-text-embedding-3-small');
    const vec = await provider.embed('Test OpenAI embedding');
    expect(vec).toHaveLength(2);
    expect(vec[0]).toBeCloseTo(0.6);
    expect(vec[1]).toBeCloseTo(0.8);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('createDefaultEmbeddingProvider returns LocalSemanticEmbedder by default without env', () => {
    const provider = createDefaultEmbeddingProvider();
    expect(provider).toBeInstanceOf(LocalSemanticEmbedder);
  });
});
