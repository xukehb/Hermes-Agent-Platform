import { describe, expect, it, vi } from 'vitest';
import { OPEN_SOURCE_MODEL_CATALOG } from '../src/system/model-catalog.js';
import { pullOllamaModelStream } from '../src/system/ollama-service.js';

describe('model catalog deployment sources', () => {
  it('marks only verified Ollama manifests as one-click deployable', () => {
    const whisper = OPEN_SOURCE_MODEL_CATALOG.find((m) => m.id === 'whisper:large-v3');
    const qwen = OPEN_SOURCE_MODEL_CATALOG.find((m) => m.id === 'qwen2.5-coder:7b');
    expect(whisper?.deployment).toBe('external');
    expect(whisper?.sourceUrl).toContain('huggingface.co');
    expect(qwen?.deployment).toBe('ollama');
  });

  it('rejects external models before starting an Ollama download', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const model of OPEN_SOURCE_MODEL_CATALOG.filter(m => m.deployment === 'external')) {
        await expect(pullOllamaModelStream(model.id, { onProgress: () => {} })).rejects.toThrow('专用推理服务');
        expect(model.modelId).toContain('/');
        expect(model.sourceUrl).toBe(`https://huggingface.co/${model.modelId}`);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('also rejects an external model when the caller uses its upstream repository ID', async () => {
    await expect(pullOllamaModelStream('openai/whisper-large-v3', { onProgress: () => {} }))
      .rejects.toThrow('专用推理服务');
  });

  it('uses the actual Qwen VL Ollama names', () => {
    expect(OPEN_SOURCE_MODEL_CATALOG.some(m => m.id === 'qwen2.5-vl:7b')).toBe(false);
    for (const tag of ['qwen2.5vl:3b', 'qwen2.5vl:7b']) {
      expect(OPEN_SOURCE_MODEL_CATALOG.find(m => m.id === tag)?.deployment).toBe('ollama');
    }
  });
});
