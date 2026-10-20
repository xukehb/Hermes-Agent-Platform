import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SpeechSettings {
  provider: 'local' | 'tencent';
  asrProvider: 'model' | 'tencent';
  asrEngine: '16k_zh' | '16k_en' | '16k_yue';
  region: string;
  voiceType: number;
  speed: number;
  volume: number;
  fallbackToLocal: boolean;
  emotionCategory: '' | 'neutral' | 'peaceful' | 'happy' | 'sad' | 'angry' | 'fear' | 'amaze' | 'disgusted' | 'sajiao';
  emotionIntensity: number;
}
export type SpeechSettingsPatch = Partial<SpeechSettings> & { secretId?: string; secretKey?: string; clearCredentials?: boolean };
interface StoredSettings extends SpeechSettings { secretId?: string; secretKey?: string }
const defaults: SpeechSettings = { provider: 'local', asrProvider: 'model', asrEngine: '16k_zh', region: 'ap-guangzhou', voiceType: 1001, speed: 0, volume: 0, fallbackToLocal: true, emotionCategory: '', emotionIntensity: 100 };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string) => createHmac('sha256', key).update(text).digest();

/** Cloud credentials stay in the host process; public settings contain status only. */
export class SpeechService {
  private readonly path: string;
  constructor(private readonly directory: string) { this.path = join(directory, 'speech.json'); }

  private read(): StoredSettings {
    if (!existsSync(this.path)) return { ...defaults };
    return { ...defaults, ...JSON.parse(readFileSync(this.path, 'utf8')) as StoredSettings };
  }

  getSettings(): SpeechSettings & { credentialsConfigured: boolean } {
    const value = this.read();
    return { asrProvider: value.asrProvider, asrEngine: value.asrEngine, provider: value.provider, region: value.region, voiceType: value.voiceType, speed: value.speed,
      volume: value.volume, fallbackToLocal: value.fallbackToLocal, emotionCategory: value.emotionCategory, emotionIntensity: value.emotionIntensity, credentialsConfigured: Boolean(value.secretId && value.secretKey) };
  }

  saveSettings(patch: SpeechSettingsPatch) {
    const current = this.read();
    const next: StoredSettings = { ...current };
    if (patch.provider !== undefined) {
      if (!['local', 'tencent'].includes(patch.provider)) throw new Error('请选择本地或腾讯云语音');
      next.provider = patch.provider;
    }
    if (patch.asrProvider !== undefined) {
      if (!['model', 'tencent'].includes(patch.asrProvider)) throw new Error('语音识别服务无效');
      next.asrProvider = patch.asrProvider;
    }
    if (patch.asrEngine !== undefined) {
      if (!['16k_zh', '16k_en', '16k_yue'].includes(patch.asrEngine)) throw new Error('语音识别语言无效');
      next.asrEngine = patch.asrEngine;
    }
    if (patch.emotionCategory !== undefined) {
      if (!['', 'neutral', 'peaceful', 'happy', 'sad', 'angry', 'fear', 'amaze', 'disgusted', 'sajiao'].includes(patch.emotionCategory)) throw new Error('情感类型无效');
      next.emotionCategory = patch.emotionCategory;
    }
    if (patch.emotionIntensity !== undefined) {
      if (!Number.isInteger(patch.emotionIntensity) || patch.emotionIntensity < 50 || patch.emotionIntensity > 200) throw new Error('情感强度需为 50 至 200 的整数');
      next.emotionIntensity = patch.emotionIntensity;
    }
    if (patch.region !== undefined) {
      if (typeof patch.region !== 'string' || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(patch.region)) throw new Error('腾讯云地域格式无效');
      next.region = patch.region;
    }
    for (const [key, min, max] of [['voiceType', 0, 1000000000], ['speed', -2, 6], ['volume', -10, 10]] as const) {
      const value = patch[key];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (key === 'voiceType' && !Number.isInteger(value))) throw new Error(`${key} 参数超出有效范围`);
        next[key] = value;
      }
    }
    if (patch.fallbackToLocal !== undefined) {
      if (typeof patch.fallbackToLocal !== 'boolean') throw new Error('语音回退配置无效');
      next.fallbackToLocal = patch.fallbackToLocal;
    }
    if (patch.clearCredentials === true) { delete next.secretId; delete next.secretKey; }
    for (const key of ['secretId', 'secretKey'] as const) {
      if (patch[key] !== undefined && typeof patch[key] !== 'string') throw new Error('腾讯云密钥格式无效');
      const value = patch[key]?.trim();
      if (value) next[key] = value;
    }
    mkdirSync(this.directory, { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    return this.getSettings();
  }

  async synthesize(rawText: string): Promise<{ audioBase64: string; mimeType: string }> {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text || [...text].length > 150) throw new Error('腾讯云单次播报需为 1 至 150 字，请缩短文本');
    const settings = this.read();
    if (!settings.secretId || !settings.secretKey) throw new Error('请先配置腾讯云 SecretId 和 SecretKey');
    const body = JSON.stringify({ Text: text, SessionId: randomUUID(), ModelType: 1, VoiceType: settings.voiceType,
      Speed: settings.speed, Volume: settings.volume, ...(settings.emotionCategory ? {EmotionCategory:settings.emotionCategory, EmotionIntensity:settings.emotionIntensity} : {}), SampleRate: 16000, Codec: 'mp3', PrimaryLanguage: /[\u4e00-\u9fff]/.test(text) ? 1 : 2 });
    const response = await this.request('tts', 'TextToVoice', '2019-08-23', body);
    if (!response.ok) throw new Error(`腾讯云 TTS HTTP ${response.status}`);
    const data = await response.json() as { Response?: { Audio?: string; Error?: { Code?: string; Message?: string } } };
    if (data.Response?.Error) throw new Error(`腾讯云 TTS：${data.Response.Error.Code || 'UnknownError'} · ${data.Response.Error.Message || '合成失败'}`);
    if (!data.Response?.Audio) throw new Error('腾讯云未返回音频');
    return { audioBase64: data.Response.Audio, mimeType: 'audio/mpeg' };
  }

  async transcribe(payload: {audioBase64: string; mimeType?: string}): Promise<{ok: true; text: string}> {
    const data = payload?.audioBase64;
    if (typeof data !== 'string' || !data || data.length > 3 * 1024 * 1024 || (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) {
      throw new Error('录音数据无效或超过 3MB，请缩短录音');
    }
    const formats: Record<string, string> = {'audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/aac':'aac'};
    const format = formats[(payload.mimeType || '').split(';')[0]!.trim().toLowerCase()];
    if (!format) throw new Error('腾讯云识别需要 WAV 或 MP3 等音频，请重新录音');
    const settings = this.read();
    const body = JSON.stringify({EngSerViceType:settings.asrEngine, SourceType:1, VoiceFormat:format, Data:data, DataLen:Buffer.from(data,'base64').length});
    const response = await this.request('asr', 'SentenceRecognition', '2019-06-14', body);
    if (!response.ok) throw new Error(`腾讯云 ASR HTTP ${response.status}`);
    const result = await response.json() as {Response?: {Result?: string; Error?: {Code?: string}}};
    if (result.Response?.Error) throw new Error(`腾讯云 ASR：${result.Response.Error.Code || 'UnknownError'}`);
    if (typeof result.Response?.Result !== 'string') throw new Error('腾讯云未返回识别结果');
    return {ok:true, text:result.Response.Result.trim()};
  }

  private async request(service: 'tts' | 'asr', action: string, version: string, body: string) {
    const settings = this.read();
    if (!settings.secretId || !settings.secretKey) throw new Error('请先配置腾讯云 SecretId 和 SecretKey');
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const host = `${service}.tencentcloudapi.com`;
    const canonical = `POST\n/\n\ncontent-type:application/json\nhost:${host}\n\ncontent-type;host\n${hash(body)}`;
    const scope = `${date}/${service}/tc3_request`;
    const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
    const signingKey = hmac(hmac(hmac(`TC3${settings.secretKey}`, date), service), 'tc3_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    const response = await fetch(`https://${host}/`, { method: 'POST', body, signal: AbortSignal.timeout(20000), headers: {
      'Content-Type': 'application/json', Host: host,
      Authorization: `TC3-HMAC-SHA256 Credential=${settings.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(timestamp), 'X-TC-Region': settings.region,
    } });
    return response;
  }

}
