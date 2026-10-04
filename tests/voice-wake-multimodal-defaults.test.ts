import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hapConfigSchema, profileSchema } from '../src/config/schema.js';
import { ConfigResolver } from '../src/config/resolver.js';
import { ConfigWriter } from '../src/config/writer.js';
import { loadConfig, validateCrossReferences } from '../src/config/loader.js';
import { GuiService } from '../src/gui/service.js';

describe('Voice Wake & Multimodal Default Models', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hap-multimodal-test-'));
    configPath = join(tempDir, 'config.toml');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('hapConfigSchema and profileSchema accept default_image_model, default_video_model, default_audio_model', () => {
    const raw = {
      default_model: 'deepseek/deepseek-chat',
      default_image_model: 'flux-schnell',
      default_video_model: 'cogvideox-5b',
      default_audio_model: 'whisper-large-v3',
      profiles: {
        creative: {
          default_image_model: 'sdxl-turbo',
          default_video_model: 'hunyuan-video',
          default_audio_model: 'cosyvoice-300m',
        },
      },
    };

    const parsedConfig = hapConfigSchema.parse(raw);
    expect(parsedConfig.default_image_model).toBe('flux-schnell');
    expect(parsedConfig.default_video_model).toBe('cogvideox-5b');
    expect(parsedConfig.default_audio_model).toBe('whisper-large-v3');

    const profile = profileSchema.parse(raw.profiles.creative);
    expect(profile.default_image_model).toBe('sdxl-turbo');
    expect(profile.default_video_model).toBe('hunyuan-video');
    expect(profile.default_audio_model).toBe('cosyvoice-300m');
  });

  it('ConfigResolver resolves default multimodal models correctly', () => {
    const tomlContent = `
default_model = "deepseek/deepseek-chat"
default_image_model = "flux-schnell"
default_video_model = "cogvideox-5b"
default_audio_model = "whisper-large-v3"

[model_providers.custom]
name = "Local AI"
base_url = "http://127.0.0.1:8000/v1"
wire_api = "chat"

[models.flux-schnell]
provider = "custom"
model = "flux-schnell"

[models.cogvideox-5b]
provider = "custom"
model = "cogvideox-5b"

[models.whisper-large-v3]
provider = "custom"
model = "whisper-large-v3"
`;
    writeFileSync(configPath, tomlContent, 'utf8');

    const resolver = new ConfigResolver(loadConfig({ path: configPath, env: {} }));
    expect(resolver.resolveDefaultModel()).toBe('deepseek/deepseek-chat');
    expect(resolver.resolveDefaultImageModel()).toBe('flux-schnell');
    expect(resolver.resolveDefaultVideoModel()).toBe('cogvideox-5b');
    expect(resolver.resolveDefaultAudioModel()).toBe('whisper-large-v3');
  });

  it('ConfigWriter setGlobals sets and persists multimodal default models', () => {
    const initialToml = `
default_model = "deepseek/deepseek-chat"

[model_providers.custom]
name = "Local AI"
base_url = "http://127.0.0.1:8000/v1"
wire_api = "chat"

[models.flux-schnell]
provider = "custom"
model = "flux-schnell"

[models.cogvideox-5b]
provider = "custom"
model = "cogvideox-5b"

[models.whisper-large-v3]
provider = "custom"
model = "whisper-large-v3"
`;
    writeFileSync(configPath, initialToml, 'utf8');

    const writer = new ConfigWriter(configPath);
    writer.setGlobals({
      defaultImageModel: 'flux-schnell',
      defaultVideoModel: 'cogvideox-5b',
      defaultAudioModel: 'whisper-large-v3',
    });

    const readBack = writer.read();
    expect(readBack.config.default_image_model).toBe('flux-schnell');
    expect(readBack.config.default_video_model).toBe('cogvideox-5b');
    expect(readBack.config.default_audio_model).toBe('whisper-large-v3');
  });

  it('validateCrossReferences verifies default multimodal model pointers', () => {
    const invalidConfig = {
      default_image_model: 'non-existent-image-model',
      default_video_model: 'non-existent-video-model',
      default_audio_model: 'non-existent-audio-model',
    };

    expect(() => validateCrossReferences(invalidConfig, configPath)).toThrow();
  });

  it('GuiService manages multimodal model defaults and voice wake settings', () => {
    const service = new GuiService(configPath);

    // Initial voice wake settings
    const initialWake = service.getVoiceWakeSettings();
    expect(initialWake).toBeDefined();
    expect(initialWake.wakeWord).toBeDefined();

    // Update voice wake settings
    const updatedWake = service.updateVoiceWakeSettings({
      wakeWord: '小赫',
      autoExecute: true,
      enabled: true,
    });
    expect(updatedWake.wakeWord).toBe('小赫');
    expect(updatedWake.autoExecute).toBe(true);

    const reloadedWake = service.getVoiceWakeSettings();
    expect(reloadedWake.wakeWord).toBe('小赫');
  });

  it('transcribeAudio returns error gracefully when audio data is empty', async () => {
    const service = new GuiService(configPath);
    const result = await service.transcribeAudio({
      audioBase64: '',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('为空');
  });

  it('GuiService manages Jarvis mode, TTS options and Arc Reactor settings in voiceWakeSettings', () => {
    const service = new GuiService(configPath);

    const updated = service.updateVoiceWakeSettings({
      wakeWord: '贾维斯',
      jarvisMode: true,
      arcReactorTheme: true,
      ttsEnabled: true,
      ttsVoice: 'Daniel',
      ttsRate: 1.05,
      ttsPitch: 0.95,
    });

    expect(updated.wakeWord).toBe('贾维斯');
    expect(updated.jarvisMode).toBe(true);
    expect(updated.arcReactorTheme).toBe(true);
    expect(updated.ttsEnabled).toBe(true);
    expect(updated.ttsVoice).toBe('Daniel');
    expect(updated.ttsRate).toBe(1.05);
    expect(updated.ttsPitch).toBe(0.95);

    const reloaded = service.getVoiceWakeSettings();
    expect(reloaded.jarvisMode).toBe(true);
    expect(reloaded.arcReactorTheme).toBe(true);
    expect(reloaded.ttsEnabled).toBe(true);
  });

  it('GuiService.systemControl handles get_time action and error states', async () => {
    const service = new GuiService(configPath);

    // 1. get_time
    const timeRes = await service.systemControl({ action: 'get_time' });
    expect(timeRes.ok).toBe(true);
    expect(timeRes.message).toContain('现在是');
    expect(timeRes.message).toContain('先生');

    // 2. open_app with empty param
    const appRes = await service.systemControl({ action: 'open_app', param: '' });
    expect(appRes.ok).toBe(false);
    expect(appRes.message).toContain('未指定');

    // 3. unknown action
    const unknownRes = await service.systemControl({ action: 'unknown_cmd' });
    expect(unknownRes.ok).toBe(false);
    expect(unknownRes.message).toContain('未知系统操作');
  });
});
