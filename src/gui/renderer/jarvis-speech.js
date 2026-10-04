/**
 * 钢铁侠贾维斯语音合成与管家人格引擎 (Jarvis Speech & Persona Engine)
 *
 * 核心特性：
 * 1. 采用纯本地 Web Speech API (SpeechSynthesis) 零依赖语音合成，即启即用，无任何网络延迟；
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

      this._initVoices();
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

    isSpeaking() {
      return this.speaking || (typeof window !== 'undefined' && window.speechSynthesis?.speaking);
    }

    /**
     * 立即打断当前朗读 (全双工打断 / Barge-in)
     */
    cancel() {
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
        const candidates = ['ting-ting', 'tingting', 'sin-ji', 'sinji', 'yunxi', 'yunjian', 'xiaoxiao', 'huihui', 'zh-cn', 'chinese'];
        for (const cand of candidates) {
          const match = this.voices.find((v) => v.name.toLowerCase().includes(cand) || v.lang.toLowerCase().replace('_', '-').startsWith('zh'));
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

      return null;
    }

    /**
     * 朗读指定文本
     */
    speak(rawText, options = {}) {
      if (!this.enabled || typeof window === 'undefined' || !window.speechSynthesis) {
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

          utterance.onstart = () => {
            this.speaking = true;
          };

          utterance.onend = () => {
            this.speaking = false;
            this.currentUtterance = null;
            resolve(true);
          };

          utterance.onerror = () => {
            this.speaking = false;
            this.currentUtterance = null;
            resolve(false);
          };

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
     * 提炼并口述执行结果摘要 (Clean Spoken Butler Summary)
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

      // 如果有中文句号/感叹号，截取前 1~2 句话
      const sentences = clean.split(/([。！？!?\n])/).filter(Boolean);
      let summary = '';
      if (sentences.length >= 2) {
        summary = sentences.slice(0, 4).join('').trim();
      } else {
        summary = clean.slice(0, 60).trim();
      }

      if (!summary || summary.length < 4) {
        summary = '操作已顺利完成，一切就绪。';
      }

      // 确保带有管家礼貌性称谓
      if (!summary.includes('先生') && !summary.includes('sir') && !summary.includes('Sir')) {
        summary = `先生，${summary}`;
      }

      return this.speak(summary);
    }
  }

  global.jarvisSpeech = new JarvisSpeechEngine();
})(typeof window !== 'undefined' ? window : globalThis);
