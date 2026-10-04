/**
 * 语音唤醒与口述指令执行控制器 (Voice Wake & Command Execution Controller)
 *
 * 核心设计：
 * 1. 针对 Electron 桌面端环境全面优化，绝不发起对 Google 云端 SpeechRecognition 服务的网络上传请求，
 *    彻底消除 Chromium 引擎的 `chunked_data_pipe_upload_data_stream.cc:217 Error: -2` 错误；
 * 2. 采用纯本地 Web Audio API (AudioContext + AnalyserNode) 低功耗 VAD 音量能量监听；
 * 3. 拾音后自动调用平台配置的本地/独立语音模型 (Whisper / SenseVoice / CosyVoice) 进行高精度 ASR 转录；
 * 4. 检测到唤醒词（如 "小赫"、"Hermes" 等）时即刻播放提示音并调度智能体执行操作；
 * 5. 支持悬浮小球与主工作台无缝跨窗口同步状态，支持一键点击录音与持续后台监听。
 */

(function (global) {
  class VoiceWakeController {
    constructor() {
      this.settings = {
        enabled: true,
        wakeWord: 'Hermes',
        autoExecute: true,
        sensitivity: 0.7,
      };

      this.status = 'idle'; // idle | listening | woken | recording | transcribing | executing
      this.statusListeners = new Set();
      this.wakeListeners = new Set();
      this.commandListeners = new Set();
      this.resultListeners = new Set();

      this.mediaStream = null;
      this.audioContext = null;
      this.analyser = null;
      this.sourceNode = null;
      this.vadTimer = null;
      this.silenceTimer = null;
      this.wakeStateTimer = null;

      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.isSpeaking = false;
      this.isManualRecording = false;
      this.isProcessingCommand = false;

      this.init();
    }

    async init() {
      try {
        if (window.hap?.getVoiceWakeSettings) {
          const remoteSettings = await window.hap.getVoiceWakeSettings();
          if (remoteSettings) {
            this.settings = { ...this.settings, ...remoteSettings };
          }
        }
      } catch (err) {
        console.warn('[VoiceWake] Failed to load remote settings:', err);
      }

      // 监听跨窗口语音事件广播
      window.hap?.onVoiceWakeEvent?.((evt) => {
        if (!evt) return;
        if (evt.type === 'settings_updated' && evt.settings) {
          this.settings = { ...this.settings, ...evt.settings };
          if (this.settings.enabled) {
            this.startListening();
          } else {
            this.stopListening();
          }
        } else if (evt.type === 'status_sync') {
          this._notifyStatus(evt.status, evt.detail);
        }
      });

      if (this.settings.enabled) {
        // 延迟 800ms 启动，确保页面音频权限与驱动上下文就绪
        setTimeout(() => {
          this.startListening();
        }, 800);
      }
    }

    onStatusChange(fn) {
      this.statusListeners.add(fn);
      fn(this.status, '');
      return () => this.statusListeners.delete(fn);
    }

    onWake(fn) {
      this.wakeListeners.add(fn);
      return () => this.wakeListeners.delete(fn);
    }

    onCommand(fn) {
      this.commandListeners.add(fn);
      return () => this.commandListeners.delete(fn);
    }

    onResult(fn) {
      this.resultListeners.add(fn);
      return () => this.resultListeners.delete(fn);
    }

    _notifyStatus(newStatus, detail = '') {
      this.status = newStatus;
      for (const fn of this.statusListeners) {
        try {
          fn(newStatus, detail);
        } catch (e) {
          console.error(e);
        }
      }
    }

    playWakeChime() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.12); // A5

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.36);
        setTimeout(() => ctx.close().catch(() => {}), 500);
      } catch (err) {
        console.warn('[VoiceWake] Audio chime not available:', err);
      }
    }

    async startListening() {
      if (!this.settings.enabled) return;
      if (this.status === 'listening' || this.status === 'woken' || this.status === 'recording') return;

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          this._notifyStatus('idle', '当前系统不支持麦克风音频采集');
          return;
        }

        if (!this.mediaStream) {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
          this._notifyStatus('idle', '浏览器不支持 AudioContext');
          return;
        }

        if (!this.audioContext || this.audioContext.state === 'closed') {
          this.audioContext = new AudioCtx();
        }

        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.3;
        this.sourceNode.connect(this.analyser);

        this._notifyStatus('listening', `语音监听待命（喊“${this.settings.wakeWord || '小赫'}”对话）`);
        this._startVadMonitor();
      } catch (err) {
        console.warn('[VoiceWake] startListening failed:', err);
        this._notifyStatus('idle', '麦克风权限未授予或音频设备忙');
      }
    }

    _startVadMonitor() {
      clearInterval(this.vadTimer);
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      // 根据用户设定的 sensitivity（默认 0.7）动态计算音量触发门限
      const sensitivity = Math.max(0.1, Math.min(1.0, this.settings.sensitivity ?? 0.7));
      const threshold = Math.round(18 * (1.1 - sensitivity * 0.6)); // 8 ~ 18 之间

      this.vadTimer = setInterval(() => {
        if (!this.analyser || this.isManualRecording || this.isProcessingCommand) return;

        this.analyser.getByteFrequencyData(dataArray);

        // 计算有效语音频段（约 100Hz - 4000Hz）的平均音量
        let sum = 0;
        const validBins = Math.min(dataArray.length, 120);
        for (let i = 2; i < validBins; i++) {
          sum += dataArray[i];
        }
        const avg = sum / (validBins - 2);

        if (avg >= threshold) {
          // 检测到说话声音
          clearTimeout(this.silenceTimer);
          if (!this.isSpeaking) {
            this.isSpeaking = true;
            this._startChunkRecording();
          }
        } else if (this.isSpeaking) {
          // 声音低于阈值，进入静音判定
          if (!this.silenceTimer) {
            this.silenceTimer = setTimeout(() => {
              this.isSpeaking = false;
              this._stopChunkRecordingAndAnalyze();
            }, 1200); // 停顿 1.2 秒判定当前语句说完
          }
        }
      }, 100);
    }

    _startChunkRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') return;
      if (!this.mediaStream) return;

      try {
        this.recordedChunks = [];
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

        const recorder = mimeType ? new MediaRecorder(this.mediaStream, { mimeType }) : new MediaRecorder(this.mediaStream);
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
        };
        recorder.start(100);
        this.mediaRecorder = recorder;

        if (this.status === 'woken') {
          this._notifyStatus('recording', '正在倾听口述指令...');
        } else {
          this._notifyStatus('listening', '检测到语音输入...');
        }
      } catch (err) {
        console.warn('[VoiceWake] Start chunk recording error:', err);
      }
    }

    _stopChunkRecordingAndAnalyze() {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;

      if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;

      this.mediaRecorder.onstop = async () => {
        const chunks = this.recordedChunks;
        this.recordedChunks = [];
        if (!chunks || chunks.length === 0) {
          this._notifyStatus('listening');
          return;
        }

        const blob = new Blob(chunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
        // 音频如果太短（小于 0.4 秒或小于 3KB），可能是轻微杂音，直接忽略
        if (blob.size < 3072) {
          this._notifyStatus('listening');
          return;
        }

        await this._processAudioChunk(blob);
      };

      try {
        this.mediaRecorder.stop();
      } catch (_) {}
    }

    async _processAudioChunk(blob) {
      if (this.isProcessingCommand) return;

      this._notifyStatus('transcribing', '正在识别语音...');
      try {
        const base64Audio = await this._blobToBase64(blob);
        const res = await window.hap.transcribeAudio({
          audioBase64,
          mimeType: blob.type,
        });

        if (res && res.ok && res.text) {
          const rawText = res.text.trim();
          this._handleTranscribedText(rawText);
        } else {
          // 未配置语音模型或转录无文字，平滑恢复待命
          this._notifyStatus('listening');
        }
      } catch (err) {
        console.warn('[VoiceWake] Chunk transcription failed:', err);
        this._notifyStatus('listening');
      }
    }

    _blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result.split(',')[1] || '');
          } else {
            resolve('');
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    _handleTranscribedText(rawText) {
      if (!rawText) {
        this._notifyStatus('listening');
        return;
      }

      const currentWakeWord = (this.settings.wakeWord || 'Hermes').trim();
      const matched = this._matchWakeWord(rawText);

      if (this.status === 'woken') {
        // 已经处于唤醒状态，此段音频即为用户指令
        const instruction = this._extractInstruction(rawText, matched || currentWakeWord) || rawText;
        this.executeCommand(instruction);
      } else if (matched) {
        // 在待命状态下检测到了唤醒词
        this._triggerWake(matched, rawText);
      } else {
        // 普通语音且不含唤醒词，静默恢复待命
        this._notifyStatus('listening');
      }
    }

    _matchWakeWord(text) {
      if (!text) return null;
      const wake = (this.settings.wakeWord || 'Hermes').trim().toLowerCase();
      const lowered = text.toLowerCase().replace(/[,.?!，。？！:：\s]/g, '');

      // 支持配置的唤醒词及常见唤醒别名
      const wakeWords = [
        wake,
        '小赫',
        'hermes',
        '小爱',
        '小艾',
        '贾维斯',
      ];
      if (wake) wakeWords.unshift(wake);

      for (const w of wakeWords) {
        const cleanW = w.toLowerCase().replace(/[,.?!，。？！:：\s]/g, '');
        if (cleanW && lowered.includes(cleanW)) {
          return w;
        }
      }
      return null;
    }

    _extractInstruction(fullText, matchedWake) {
      if (!fullText) return '';
      let cleaned = fullText.trim();
      if (matchedWake) {
        const idx = cleaned.toLowerCase().indexOf(matchedWake.toLowerCase());
        if (idx !== -1) {
          cleaned = cleaned.slice(idx + matchedWake.length);
        }
      }
      return cleaned.replace(/^[,.?!，。？！:：\s]+/, '').trim();
    }

    _triggerWake(matchedWord, fullSentence = '') {
      this.playWakeChime();
      this._notifyStatus('woken', `已唤醒！唤醒词: [${matchedWord}]`);

      for (const fn of this.wakeListeners) {
        try {
          fn(matchedWord);
        } catch (e) {
          console.error(e);
        }
      }

      const inlineInstruction = this._extractInstruction(fullSentence, matchedWord);
      if (inlineInstruction && inlineInstruction.length >= 2) {
        // 用户一句话连着说了指令："小赫 帮我写个脚本"
        this.executeCommand(inlineInstruction);
      } else {
        // 仅说了唤醒词，等待用户接下来的指令
        clearTimeout(this.wakeStateTimer);
        this.wakeStateTimer = setTimeout(() => {
          if (this.status === 'woken') {
            this._notifyStatus('listening', '等待语音输入超时，恢复待命');
          }
        }, 8000);
      }
    }

    async executeCommand(instructionText) {
      const text = instructionText.trim();
      if (!text || this.isProcessingCommand) return;
      this.isProcessingCommand = true;
      clearTimeout(this.silenceTimer);
      clearTimeout(this.wakeStateTimer);

      this._notifyStatus('executing', `正在执行指令: "${text}"`);

      for (const fn of this.commandListeners) {
        try {
          fn(text);
        } catch (e) {
          console.error(e);
        }
      }

      try {
        if (!this.settings.autoExecute) {
          this._notifyStatus('idle', `已识别口述指令: "${text}"（自动执行未开启）`);
          this.isProcessingCommand = false;
          return;
        }

        // 调用 Hermes Agent 进行任务执行
        let reply = '';
        if (window.hap?.chat) {
          const res = await window.hap.chat({
            input: text,
            sessionKey: 'voice_wake_session',
          });

          const outcomeText = res?.outcome?.text || res?.output || (typeof res === 'string' ? res : '');
          reply = outcomeText || '指令已成功派发执行完成';
        } else {
          reply = `已接收并处理指令: ${text}`;
        }

        this._notifyStatus('idle', `执行完成: ${reply.slice(0, 36)}...`);

        for (const fn of this.resultListeners) {
          try {
            fn({ ok: true, instruction: text, reply });
          } catch (e) {
            console.error(e);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this._notifyStatus('idle', `执行异常: ${errMsg}`);
        for (const fn of this.resultListeners) {
          try {
            fn({ ok: false, instruction: text, error: errMsg });
          } catch (e) {
            console.error(e);
          }
        }
      } finally {
        setTimeout(() => {
          this.isProcessingCommand = false;
          if (this.settings.enabled) {
            this.startListening();
          }
        }, 2200);
      }
    }

    // 提供一键按住录音或单次点击录音并提交语音模型 ASR 转录
    async startManualRecording() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('系统不支持麦克风采集');
        }
        if (!this.mediaStream) {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        this.recordedChunks = [];

        const options = { mimeType: 'audio/webm' };
        if (!MediaRecorder.isTypeSupported('audio/webm')) {
          delete options.mimeType;
        }

        const recorder = new MediaRecorder(this.mediaStream, options);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.recordedChunks.push(e.data);
        };

        recorder.start(100);
        this.mediaRecorder = recorder;
        this.isManualRecording = true;
        this._notifyStatus('recording', '正在录制口述指令...');
      } catch (err) {
        this._notifyStatus('idle', '录音启动失败: ' + err.message);
      }
    }

    async stopManualRecordingAndTranscribe() {
      if (!this.mediaRecorder || !this.isManualRecording) return;
      this.isManualRecording = false;

      return new Promise((resolve) => {
        this.mediaRecorder.onstop = async () => {
          this._notifyStatus('transcribing', '正在调用语音模型转写...');
          try {
            const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
            const base64Audio = await this._blobToBase64(blob);
            const res = await window.hap.transcribeAudio({
              audioBase64,
              mimeType: blob.type,
            });

            if (res && res.ok && res.text) {
              const text = res.text.trim();
              resolve(text);
              await this.executeCommand(text);
            } else {
              const err = res?.error || '未识别到有效语音，请检查是否已在设置中配置语音模型（如 Whisper）';
              this._notifyStatus('idle', err);
              resolve('');
            }
          } catch (err) {
            this._notifyStatus('idle', '转录失败: ' + err.message);
            resolve('');
          }
        };

        try {
          this.mediaRecorder.stop();
        } catch (_) {
          resolve('');
        }
      });
    }

    stopListening() {
      clearInterval(this.vadTimer);
      clearTimeout(this.silenceTimer);
      clearTimeout(this.wakeStateTimer);

      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        try {
          this.mediaRecorder.stop();
        } catch (_) {}
      }
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch (_) {}
        this.sourceNode = null;
      }
      if (this.analyser) {
        try {
          this.analyser.disconnect();
        } catch (_) {}
        this.analyser = null;
      }
      if (this.mediaStream) {
        try {
          this.mediaStream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        this.mediaStream = null;
      }
      this.isSpeaking = false;
      this._notifyStatus('idle');
    }

    async updateSettings(patch) {
      this.settings = { ...this.settings, ...patch };
      if (window.hap?.updateVoiceWakeSettings) {
        await window.hap.updateVoiceWakeSettings(this.settings);
      }
      if (window.hap?.broadcastVoiceWake) {
        await window.hap.broadcastVoiceWake({
          type: 'settings_updated',
          settings: this.settings,
        });
      }
      if (this.settings.enabled) {
        this.startListening();
      } else {
        this.stopListening();
      }
    }
  }

  // 单例导出
  const instance = new VoiceWakeController();
  global.voiceWakeController = instance;
})(window);
