import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferModelCapabilities } from '../src/config/defaults.js';
import { ConfigResolver } from '../src/config/resolver.js';
import { ConfigWriter } from '../src/config/writer.js';
import { OPEN_SOURCE_MODEL_CATALOG, type ModelCategory } from '../src/system/model-catalog.js';
import { getHardwareRecommendationProfile } from '../src/system/model-recommender.js';
import { upsertModel as opsUpsertModel } from '../src/gui/provider-operations.js';

describe('Multimodal Local Model Deployment & Category System', () => {
  it('1. OPEN_SOURCE_MODEL_CATALOG 包含语音、图片、视频模型分类', () => {
    const audioModels = OPEN_SOURCE_MODEL_CATALOG.filter((m) => m.category === 'audio');
    const imageModels = OPEN_SOURCE_MODEL_CATALOG.filter((m) => m.category === 'image');
    const videoModels = OPEN_SOURCE_MODEL_CATALOG.filter((m) => m.category === 'video');

    expect(audioModels.length).toBeGreaterThanOrEqual(4);
    expect(imageModels.length).toBeGreaterThanOrEqual(3);
    expect(videoModels.length).toBeGreaterThanOrEqual(2);

    // 语音模型检查
    const whisper = audioModels.find((m) => m.id === 'whisper:large-v3');
    expect(whisper).toBeDefined();
    expect(whisper?.displayName).toContain('Whisper');
    expect(whisper?.family).toBe('OpenAI');

    const qwenAudio = audioModels.find((m) => m.id === 'qwen2-audio:7b');
    expect(qwenAudio).toBeDefined();
    expect(qwenAudio?.displayName).toContain('Qwen2-Audio');

    const cosy = audioModels.find((m) => m.id === 'cosyvoice:latest');
    expect(cosy).toBeDefined();

    // 图片模型检查
    const flux = imageModels.find((m) => m.id === 'flux-schnell');
    expect(flux).toBeDefined();
    expect(flux?.displayName).toContain('FLUX.1');

    const sd = imageModels.find((m) => m.id === 'stable-diffusion-3.5:medium');
    expect(sd).toBeDefined();

    const sdxl = imageModels.find((m) => m.id === 'sdxl-turbo');
    expect(sdxl).toBeDefined();

    // 视频模型检查
    const cogvideo = videoModels.find((m) => m.id === 'cogvideox:5b');
    expect(cogvideo).toBeDefined();
    expect(cogvideo?.displayName).toContain('CogVideoX');

    const hunyuan = videoModels.find((m) => m.id === 'hunyuan-video:latest');
    expect(hunyuan).toBeDefined();
    expect(hunyuan?.displayName).toContain('HunyuanVideo');
  });

  it('2. inferModelCapabilities 自动推断语音、图片、视频模型能力', () => {
    // 语音模型
    const audioTestList = [
      'whisper:large-v3',
      'whisper-base',
      'qwen2-audio:7b',
      'cosyvoice:latest',
      'sensevoice-small',
      'chat-tts:latest',
    ];
    for (const name of audioTestList) {
      const caps = inferModelCapabilities(name);
      expect(caps, `模型 ${name} 应当被推断包含 audio 能力`).toContain('audio');
    }

    // 图片模型
    const imageTestList = [
      'flux-schnell',
      'flux-dev',
      'stable-diffusion-3.5',
      'sdxl-turbo',
      'dall-e-3',
      'imagen-3',
    ];
    for (const name of imageTestList) {
      const caps = inferModelCapabilities(name);
      expect(caps, `模型 ${name} 应当被推断包含 image 能力`).toContain('image');
    }

    // 视频模型
    const videoTestList = [
      'cogvideox:5b',
      'hunyuan-video:latest',
      'sora-preview',
      'kling-video',
    ];
    for (const name of videoTestList) {
      const caps = inferModelCapabilities(name);
      expect(caps, `模型 ${name} 应当被推断包含 video 能力`).toContain('video');
    }
  });

  it('3. getHardwareRecommendationProfile 支持按 audio, image, video 分类过滤并评估硬件', () => {
    const mockSysInfo = {
      os: { platform: 'darwin', type: 'Darwin' },
      memory: { totalBytes: 32 * 1024 * 1024 * 1024, freeBytes: 20 * 1024 * 1024 * 1024 },
      disk: { totalBytes: 500 * 1024 * 1024 * 1024, freeBytes: 200 * 1024 * 1024 * 1024 },
      gpus: [{ name: 'Apple M3 Pro', memoryTotalBytes: 32 * 1024 * 1024 * 1024 }],
    } as any;

    const audioProfile = getHardwareRecommendationProfile(mockSysInfo, new Set(), 'audio' as ModelCategory);
    expect(audioProfile.evaluations.length).toBeGreaterThanOrEqual(4);
    for (const e of audioProfile.evaluations) {
      expect(e.model.category).toBe('audio');
    }

    const imageProfile = getHardwareRecommendationProfile(mockSysInfo, new Set(), 'image' as ModelCategory);
    expect(imageProfile.evaluations.length).toBeGreaterThanOrEqual(3);
    for (const e of imageProfile.evaluations) {
      expect(e.model.category).toBe('image');
    }

    const videoProfile = getHardwareRecommendationProfile(mockSysInfo, new Set(), 'video' as ModelCategory);
    expect(videoProfile.evaluations.length).toBeGreaterThanOrEqual(2);
    for (const e of videoProfile.evaluations) {
      expect(e.model.category).toBe('video');
    }
  });

  it('4. ConfigResolver 和 ConfigWriter 支持模型独立 category、base_url 和 api_key', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hap-multimodal-test-'));
    const cfgPath = join(tmp, 'config.toml');

    try {
      const writer = new ConfigWriter(cfgPath);
      writer.upsertProvider('local-whisper', {
        name: '本地语音服务',
        base_url: 'http://127.0.0.1:8000/v1',
      });

      writer.upsertModel('my-whisper', {
        provider: 'local-whisper',
        model: 'whisper:large-v3',
        category: 'audio',
        base_url: 'http://127.0.0.1:8000/v1',
        api_key: 'custom-local-token',
        capabilities: ['audio', 'tools', 'streaming'],
      });

      writer.upsertModel('my-flux', {
        provider: 'local-whisper',
        model: 'flux-schnell',
        category: 'image',
        base_url: 'http://127.0.0.1:7860/v1',
        capabilities: ['image'],
      });

      const resolver = new ConfigResolver({
        path: cfgPath,
        exists: true,
        raw: '',
        loadedAt: 0,
        config: writer.read().config,
      });

      const models = resolver.resolveModels();
      const whisperModel = models.get('my-whisper');
      expect(whisperModel).toBeDefined();
      expect(whisperModel?.category).toBe('audio');
      expect(whisperModel?.baseUrl).toBe('http://127.0.0.1:8000/v1');
      expect(whisperModel?.apiKey).toBe('custom-local-token');
      expect(whisperModel?.capabilities).toContain('audio');

      const fluxModel = models.get('my-flux');
      expect(fluxModel).toBeDefined();
      expect(fluxModel?.category).toBe('image');
      expect(fluxModel?.baseUrl).toBe('http://127.0.0.1:7860/v1');
      expect(fluxModel?.capabilities).toContain('image');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('5. provider-operations 中的 upsertModel 能够正确保存包含 category, baseUrl, apiKey 的本地化模型', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hap-ops-test-'));
    const cfgPath = join(tmp, 'config.toml');

    try {
      const writer = new ConfigWriter(cfgPath);
      writer.upsertProvider('custom-local', {
        name: '本地自建服务',
        base_url: 'http://127.0.0.1:9000/v1',
      });

      const res = opsUpsertModel(cfgPath, {
        alias: 'local-cogvideo',
        provider: 'custom-local',
        model: 'cogvideox:5b',
        category: 'video',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: 'secret-key-123',
        capabilities: ['video'],
      });
      expect(res.ok).toBe(true);

      const parsed = writer.read().config;
      const modelEntry = parsed.models?.['local-cogvideo'];
      expect(modelEntry).toBeDefined();
      expect(modelEntry?.model).toBe('cogvideox:5b');
      expect(modelEntry?.category).toBe('video');
      expect(modelEntry?.base_url).toBe('http://127.0.0.1:8080/v1');
      expect(modelEntry?.api_key).toBe('secret-key-123');
      expect(modelEntry?.capabilities).toEqual(['video']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
