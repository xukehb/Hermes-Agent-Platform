import { describe, expect, it } from 'vitest';
import { inferModelCapabilities } from '../src/config/defaults.js';
import { ConfigResolver } from '../src/config/resolver.js';
import { OPEN_SOURCE_MODEL_CATALOG } from '../src/system/model-catalog.js';
import { getHardwareRecommendationProfile } from '../src/system/model-recommender.js';

describe('Vision & Multimodal Model Identification and Labeling', () => {
  it('1. inferModelCapabilities 准确识别常见多模态视觉模型', () => {
    // 应当识别出 vision 的模型
    const visionModels = [
      'gpt-5.5',
      'gpt-5.4-mini',
      'gpt-4o',
      'gpt-4o-audio-preview',
      'gpt-image-2',
      'qwen2.5-vl:7b',
      'qwen2-vl',
      'llava:7b',
      'llava-phi3:3.8b',
      'minicpm-v:8b',
      'internvl2.5-8b',
      'cogvlm2-19b',
      'glm-4v-9b',
      'phi-3.5-vision',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'claude-3-opus',
      'claude-sonnet-4-5',
    ];

    for (const name of visionModels) {
      const caps = inferModelCapabilities(name);
      expect(caps, `模型 ${name} 应当包含 vision 能力`).toContain('vision');
    }

    // 不应识别出 vision 的纯文本模型
    const textModels = [
      'deepseek-chat',
      'deepseek-v4',
      'deepseek-v4-pro',
      'deepseek-flash',
      'deepseek-r1:8b',
      'qwen2.5-coder:7b',
      'qwen2.5:32b',
      'llama3.1:8b',
      'llama3.3:70b',
      'glm-4.6',
      'kimi-k3',
      'codex-auto-review',
    ];

    for (const name of textModels) {
      const caps = inferModelCapabilities(name);
      expect(caps, `模型 ${name} 不应被误判为 vision`).not.toContain('vision');
    }
  });

  it('2. ConfigResolver 在未显式声明 capabilities 时自动为视觉模型补齐 vision 能力', () => {
    const resolver = new ConfigResolver({
      path: '/virtual/config.toml',
      exists: true,
      raw: '',
      loadedAt: 0,
      config: {
        models: {
          'my-gpt5': {
            provider: 'openai',
            model: 'gpt-5.5',
          },
          'my-deepseek': {
            provider: 'deepseek',
            model: 'deepseek-chat',
          },
          'custom-manual': {
            provider: 'openai',
            model: 'gpt-5.5',
            capabilities: ['tools'], // 显式声明覆盖
          },
        },
      },
    });

    const models = resolver.resolveModels();

    const gpt5 = models.get('my-gpt5');
    expect(gpt5).toBeDefined();
    expect(gpt5?.capabilities).toContain('vision');
    expect(gpt5?.capabilities).toContain('tools');
    expect(gpt5?.capabilities).toContain('streaming');

    const deepseek = models.get('my-deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.capabilities).not.toContain('vision');
    expect(deepseek?.capabilities).toContain('tools');

    const custom = models.get('custom-manual');
    expect(custom).toBeDefined();
    expect(custom?.capabilities).toEqual(['tools']);
  });

  it('3. OPEN_SOURCE_MODEL_CATALOG 包含视觉多模态分类与代表性开源模型', () => {
    const visionModels = OPEN_SOURCE_MODEL_CATALOG.filter((m) => m.category === 'vision');
    expect(visionModels.length).toBeGreaterThanOrEqual(3);

    const qwenVl = visionModels.find((m) => m.id === 'qwen2.5-vl:7b');
    expect(qwenVl).toBeDefined();
    expect(qwenVl?.displayName).toContain('视觉');
    expect(qwenVl?.tags).toContain('视觉多模态');

    const llava = visionModels.find((m) => m.id === 'llava:7b');
    expect(llava).toBeDefined();

    const minicpm = visionModels.find((m) => m.id === 'minicpm-v:8b');
    expect(minicpm).toBeDefined();
  });

  it('4. getHardwareRecommendationProfile 支持按 vision 分类筛选多模态模型', () => {
    const mockSysInfo = {
      memory: { totalBytes: 16 * 1024 * 1024 * 1024, freeBytes: 10 * 1024 * 1024 * 1024 },
      disk: { totalBytes: 500 * 1024 * 1024 * 1024, freeBytes: 200 * 1024 * 1024 * 1024 },
      gpus: [{ model: 'NVIDIA RTX 4070', vramBytes: 12 * 1024 * 1024 * 1024 }],
    } as any;

    const profile = getHardwareRecommendationProfile(mockSysInfo, new Set(), 'vision');
    expect(profile.evaluations.length).toBeGreaterThan(0);
    for (const ev of profile.evaluations) {
      expect(ev.model.category).toBe('vision');
    }
  });
});
