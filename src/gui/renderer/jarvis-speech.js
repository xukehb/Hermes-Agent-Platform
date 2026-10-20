/**
 * 钢铁侠贾维斯语音合成与管家人格引擎 (Jarvis Speech & Persona Engine)
 *
 * 核心特性：
 * 1. 支持系统本地语音与腾讯云 TTS，云端签名由主进程处理；
 * 2. 智能优选沉稳磁性英伦管家音色 (如 macOS "Daniel" / Siri 英音，Windows "Yunxi" / "Natural" 等)；
 * 3. 尊称“先生 (Sir)”，提供沉稳、严谨、优雅的管家交互语调；
 * 4. 全双工支持 (Barge-in)：检测到用户开口即刻打断发声，随时响应全新指令；
 * 5. 智能摘要播报：自动过滤长篇代码、Markdown 格式符与技术堆栈，提炼优雅简练的口述汇报。
 */

(function (global) {
  class JarvisSpeechEngine {
    constructor() {
      this.enabled = true;
      this.voiceName = 'default';
      this.rate = 1.02;
      this.pitch = 0.95;
      this.volume = 1.0;
      this.speaking = false;
      this.voices = [];
      this.currentUtterance = null;
      this.finishCurrent = null;
      this.speechId = 0;
      this.lastSpokenText = '';
      this.lastSpeechAt = 0;
      this.cloudSettings = { provider: 'local', fallbackToLocal: true };
      this.cloudApi = global.hap;
      this.currentAudio = null;
      this.finishAudio = null;
      this.reloadCloudSettings();
      global.hap?.onVoiceWakeEvent?.((event) => {
        if (event?.type === 'speech_settings_updated') this.reloadCloudSettings();
      });

      this._initVoices();
    }

    async reloadCloudSettings() {
      try {
        if (this.cloudApi?.getSpeechSettings) this.cloudSettings = await this.cloudApi.getSpeechSettings();
      } catch (error) {
        console.warn('[JarvisSpeech] 无法读取云语音设置:', error);
      }
    }

    _initVoices() {
      if (typeof window === 'undefined' || !window.speechSynthesis) return;

      const load = () => {
        try {
          this.voices = window.speechSynthesis.getVoices() || [];
        } catch (_) {}
      };

      load();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = load;
      }
    }

    configure(settings = {}) {
      if (typeof settings.ttsEnabled === 'boolean') {
        this.enabled = settings.ttsEnabled;
        if (!this.enabled) this.cancel();
      }
      if (typeof settings.ttsVoice === 'string') {
        this.voiceName = settings.ttsVoice;
      }
      if (typeof settings.ttsRate === 'number') {
        this.rate = Math.max(0.6, Math.min(1.8, settings.ttsRate));
      }
      if (typeof settings.ttsPitch === 'number') {
        this.pitch = Math.max(0.6, Math.min(1.5, settings.ttsPitch));
      }
    }

    matchesRecentSpeech(text) {
      if (!this.isSpeaking() && Date.now() - this.lastSpeechAt > 6000) return false;
      const normalize = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const heard = normalize(text);
      const spoken = normalize(this.lastSpokenText);
      if (heard.length < 6 || !spoken) return false;
      if (spoken.includes(heard) || heard.includes(spoken)) return true;
      // Allow minor transcription differences in speaker echo.
      const pairs = Array.from({length: heard.length - 1}, (_, i) => heard.slice(i, i + 2));
      return heard.length >= 8 && pairs.filter(pair => spoken.includes(pair)).length / pairs.length >= 0.7;
    }

    isSpeaking() {
      return Boolean(this.speaking || (typeof window !== 'undefined' && window.speechSynthesis?.speaking));
    }

    /**
     * 立即打断当前朗读 (全双工打断 / Barge-in)
     */
    cancel() {
      this.lastSpeechAt = Date.now();
      this.speechId++;
      if (this.finishAudio) this.finishAudio(false);
      this.finishAudio = null;
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio.removeAttribute('src');
        this.currentAudio = null;
      }
      const finish = this.finishCurrent;
      this.finishCurrent = null;
      this.currentUtterance = null;
      if (finish) finish(false);
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch (_) {}
      }
      this.speaking = false;
      this.currentUtterance = null;
    }

    _pickBestVoice(isChinese = true) {
      if (!this.voices || this.voices.length === 0) {
        this._initVoices();
      }

      // 如果用户特别指定了音色名称
      if (this.voiceName && this.voiceName !== 'default') {
        const found = this.voices.find((v) => v.name.toLowerCase().includes(this.voiceName.toLowerCase()));
        if (found) return found;
      }

      if (isChinese) {
        // 优选沉稳自然普通话音色
        const candidates = ['yunxi', 'yunjian', 'yunyang', 'li-mu', 'li mu', 'zh-cn', 'chinese'];
        for (const cand of candidates) {
          const match = this.voices.find((v) => v.name.toLowerCase().includes(cand));
          if (match) return match;
        }
      } else {
        // 优选标志性英国绅士男音 (如 Daniel - 经典 Jarvis 音色)
        const candidates = ['daniel', 'oliver', 'arthur', 'george', 'en-gb', 'uk english male', 'en-us'];
        for (const cand of candidates) {
          const match = this.voices.find((v) => v.name.toLowerCase().includes(cand));
          if (match) return match;
        }
      }

      return this.voices.find(v => v.lang.toLowerCase().replace('_', '-').startsWith(isChinese ? 'zh' : 'en')) || null;
    }

    /**
     * 朗读指定文本
     */
    speak(rawText, options = {}) {
      if (!this.enabled && !options.preview) return Promise.resolve(false);
      const text = String(rawText || '').trim();
      if (!text) return Promise.resolve(false);
      this.lastSpokenText = text;
      this.lastSpeechAt = Date.now();
      if (this.cloudSettings.provider === 'tencent') return this._speakTencent(text, options);
      return this._speakLocal(text, options);
    }

    _speakTencent(text, options) {
      this.cancel();
      const id = this.speechId;
      this.speaking = true;
      return new Promise((resolve) => {
        const finish = (ok) => {
          if (id === this.speechId) {
            this.speaking = false;
            this.finishCurrent = null;
            this.currentAudio = null;
          }
          this.lastSpeechAt = Date.now();
          resolve(ok);
        };
        this.finishCurrent = finish;
        const run = async () => {
          try {
            if (!this.cloudApi?.synthesizeSpeech) throw new Error('当前环境不支持腾讯云语音');
            const characters = Array.from(text);
            for (let offset = 0; offset < characters.length; offset += 140) {
              const result = await this.cloudApi.synthesizeSpeech(characters.slice(offset, offset + 140).join(''));
              if (id !== this.speechId) return;
              const audio = new Audio(`data:${result.mimeType};base64,${result.audioBase64}`);
              this.currentAudio = audio;
              const played = await new Promise((done, reject) => {
                this.finishAudio = done;
                audio.onended = () => done(true);
                audio.onerror = () => reject(new Error('腾讯云语音音频播放失败'));
                Promise.resolve(audio.play()).catch(reject);
              });
              if (id !== this.speechId) return;
              this.finishAudio = null;
              this.currentAudio = null;
              if (!played) { finish(false); return; }
            }
            finish(true);
          } catch (error) {
            if (id !== this.speechId) return;
            global.dispatchEvent?.(new CustomEvent('jarvis-speech-error', { detail: { message: error.message, fallback: this.cloudSettings.fallbackToLocal } }));
            if (this.cloudSettings.fallbackToLocal) {
              this.finishCurrent = null;
              this.cancel();
              resolve(await this._speakLocal(text, options));
            } else {
              this.cancel();
              finish(false);
            }
          }
        };
        void run();
      });
    }

    _speakLocal(rawText, options = {}) {
      if ((!this.enabled && !options.preview) || typeof window === 'undefined' || !window.speechSynthesis) {
        return Promise.resolve(false);
      }

      const text = String(rawText || '').trim();
      if (!text) return Promise.resolve(false);

      this.cancel();

      return new Promise((resolve) => {
        try {
          const utterance = new SpeechSynthesisUtterance(text);
          const isChinese = /[\u4e00-\u9fa5]/.test(text);
          const chosenVoice = this._pickBestVoice(isChinese);

          if (chosenVoice) {
            utterance.voice = chosenVoice;
            utterance.lang = chosenVoice.lang;
          } else {
            utterance.lang = isChinese ? 'zh-CN' : 'en-GB';
          }

          utterance.rate = options.rate !== undefined ? options.rate : this.rate;
          utterance.pitch = options.pitch !== undefined ? options.pitch : this.pitch;
          utterance.volume = options.volume !== undefined ? options.volume : this.volume;

          const finish = (ok) => {
            if (this.currentUtterance === utterance) {
              this.speaking = false;
              this.currentUtterance = null;
              this.finishCurrent = null;
            }
            this.lastSpeechAt = Date.now();
            resolve(ok);
          };
          this.finishCurrent = finish;
          utterance.onstart = () => {
            if (this.currentUtterance === utterance) this.speaking = true;
          };

          utterance.onend = () => finish(true);
          utterance.onerror = () => finish(false);

          this.currentUtterance = utterance;
          window.speechSynthesis.speak(utterance);
        } catch (err) {
          console.warn('[JarvisSpeech] Speak error:', err);
          this.speaking = false;
          resolve(false);
        }
      });
    }

    /**
     * 唤醒问候语 (Wake-up Greetings)
     */
    speakGreeting(wakeWord = '贾维斯') {
      const isEnglishWake = /^[a-zA-Z\s]+$/.test(wakeWord.trim());
      if (isEnglishWake) {
        const enGreetings = [
          'At your service, sir.',
          'Online and ready, sir.',
          'Yes, sir?',
          'Jarvis here. How may I assist you, sir?',
        ];
        const phrase = enGreetings[Math.floor(Math.random() * enGreetings.length)];
        return this.speak(phrase);
      }

      const cnGreetings = [
        '随时为您效劳，先生。',
        '我在，请吩咐，先生。',
        '先生，贾维斯已就绪。',
        '请说，先生。',
      ];
      const phrase = cnGreetings[Math.floor(Math.random() * cnGreetings.length)];
      return this.speak(phrase);
    }

    /**
     * 指令接收确认 (Action Acknowledgement)
     */
    speakActionAck(cmdText = '') {
      if (/看(看|下)?(屏幕|报错|画面)/.test(cmdText) || /look at (the )?screen/i.test(cmdText)) {
        return this.speak('正在捕获并分析当前屏幕，先生。');
      }
      return this.speak('好的，先生，正在为您处理。');
    }

    /**
     * 系统级快车道控制结果播报
     */
    speakFastAction(message) {
      return this.speak(message);
    }

    /**
     * 清理格式后完整播报执行结果（保留历史方法名）
     */
    speakSummary(rawReply, hasError = false) {
      if (hasError) {
        return this.speak('抱歉先生，执行过程中出现了一点异常。');
      }

      if (!rawReply || typeof rawReply !== 'string') {
        return this.speak('先生，操作已执行完毕。');
      }

      // 清理 Markdown 代码块、链接、多余标点
      let clean = rawReply
        .replace(/```[\s\S]*?```/g, '代码块已生成。')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_#~>]/g, '')
        .replace(/\n+/g, ' ')
        .trim();

      // Keep all spoken prose. Tencent's request limit is handled by chunking,
      // never by removing the remainder of the reply.
      let summary = clean;
      if (!summary) summary = '先生，操作已执行完毕。';

      // 确保带有管家礼貌性称谓
      if (!summary.includes('先生') && !summary.includes('sir') && !summary.includes('Sir')) {
        summary = `先生，${summary}`;
      }

      return this.speak(summary);
    }
  }

  global.jarvisSpeech = new JarvisSpeechEngine();
})(typeof window !== 'undefined' ? window : globalThis);
