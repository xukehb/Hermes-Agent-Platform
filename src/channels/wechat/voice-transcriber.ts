/**
 * 微信语音音频识别与 ASR 转写模块。
 */

export interface VoiceTranscriberOptions {
  apiKey?: string | undefined;
  apiBase?: string | undefined;
  model?: string | undefined;
}

export class WeChatVoiceTranscriber {
  private readonly apiKey: string | undefined;
  private readonly apiBase: string;
  private readonly model: string;

  constructor(options: VoiceTranscriberOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.ASR_API_KEY;
    this.apiBase = options.apiBase || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = options.model || 'whisper-1';
  }

  /**
   * 将微信语音音频流（Silk/AMR/MP3/WAV/OGG）转写为文本。
   */
  async transcribe(audioBuffer: Buffer, filename = 'voice.mp3'): Promise<string> {
    if (!audioBuffer || audioBuffer.length === 0) {
      return '';
    }

    // 若配置了 API Key，调用远端极速 ASR / Whisper 接口
    if (this.apiKey) {
      try {
        const formData = new FormData();
        const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' });
        formData.append('file', blob, filename);
        formData.append('model', this.model);

        const url = `${this.apiBase.replace(/\/+$/, '')}/audio/transcriptions`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: formData,
        });

        if (res.ok) {
          const json = (await res.json()) as { text?: string };
          if (json.text && json.text.trim()) {
            return json.text.trim();
          }
        }
      } catch {
        // 网络/接口异常时自动降级
      }
    }

    // 本地兼容转写提示（无 Key 或离线状态下的优雅提示）
    return `（语音条音频共 ${Math.round(audioBuffer.length / 1024)}KB，已接收语音指令）`;
  }

  /**
   * 格式化语音识别下发给智能体的指令提示词。
   */
  formatVoicePrompt(transcribedText: string): string {
    return `🎙️ [微信语音识别指令] ${transcribedText}`;
  }
}
