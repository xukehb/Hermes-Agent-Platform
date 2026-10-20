/**
 * 钢铁侠贾维斯语音中枢与全双工指令控制器 (Jarvis Voice Core & Duplex Controller)
 *
 * 核心设计：
 * 1. 针对 Electron 桌面端优化，纯本地 Web Audio API (AudioContext + AnalyserNode) 低功耗监听；
 * 2. 深度集成 JarvisSpeechEngine 语音发声，开口回话、唤醒问候、任务口述与全双工即时打断 (Barge-in)；
 * 3. 屏幕视觉感知 (Screen Vision)：语音口述“帮我看屏幕/看报错”瞬间捕获屏幕并调用多模态模型分析；
 * 4. 系统级原生控制快车道 (System Control Fast Path)：毫秒级响应音量调节、静音、锁屏、时间查询与软件启动；
 * 5. 方舟反应堆频谱流：对外暴露 getFrequencyData()，驱动 HUD 同心刻度环与流光粒子随声音实时律动；
 * 6. 10 秒连续多轮对话窗口 (Continuous Dialogue)：一次唤醒后可自然交谈，免重复喊唤醒词。
 */

(function (global) {
  class VoiceWakeController {
    constructor() {
      this.settings = {
        enabled: true,
        wakeWord: '贾维斯',
        autoExecute: true,
        sensitivity: 0.7,
        ttsEnabled: true,
        ttsVoice: 'default',
        ttsRate: 1.0,
        ttsPitch: 0.95,
        jarvisMode: true,
        arcReactorTheme: true,
      };

      this.statusDetail = '语音监听尚未启动';
      this.lastRecognizedText = '';
      this.inputLevel = 0;
      this.noiseFloor = 0.002;
      this.voiceThreshold = 0.007;
      this.startPromise = null;
      this.listenGeneration = 0;
      this.isTranscribing = false;
      this.recordingLimitTimer = null;
      this.recordedDuringPlayback = false;
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
      this.activeDialogueTimer = null;

      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.isSpeaking = false;
      this.isManualRecording = false;
      this.isProcessingCommand = false;
      this.isInActiveDialogue = false;

      this.init();
    }

    async init() {
      try {
        if (window.hap?.getVoiceWakeSettings) {
          const remoteSettings = await window.hap.getVoiceWakeSettings();
          if (remoteSettings) {
            this.settings = { ...this.settings, ...remoteSettings };
            if (global.jarvisSpeech) {
              global.jarvisSpeech.configure(this.settings);
            }
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
          if (global.jarvisSpeech) {
            global.jarvisSpeech.configure(this.settings);
          }
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
        // 延迟 800ms 启动，确保音频权限与驱动上下文就绪
        setTimeout(() => {
          this.startListening();
        }, 800);
      }
    }

    onStatusChange(fn) {
      this.statusListeners.add(fn);
      fn(this.status, this.statusDetail);
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
      this.statusDetail = detail;
      for (const fn of this.statusListeners) {
        try {
          fn(newStatus, detail);
        } catch (e) {
          console.error(e);
        }
      }
    }

    /**
     * 获取实时音频频谱与能量（用于方舟反应堆 Arc Reactor HUD 动效渲染）
     */
    getFrequencyData() {
      if (!this.analyser) {
        return { energy: 0, freqs: new Uint8Array(64) };
      }
      const freqs = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(freqs);
      let sum = 0;
      const count = Math.min(freqs.length, 120);
      for (let i = 2; i < count; i++) {
        sum += freqs[i];
      }
      const energy = count > 2 ? sum / ((count - 2) * 255) : 0;
      return { energy, freqs };
    }

    playWakeChime() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        // 贾维斯高科技方舟音色
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

    getDiagnostics() {
      const track = this.mediaStream?.getAudioTracks()[0];
      return {
        status: this.status, detail: this.statusDetail,
        listening: Boolean(track?.readyState === 'live' && track.enabled && !track.muted && this.audioContext?.state === 'running' && this.vadTimer),
        microphone: track?.label || '', level: this.inputLevel, threshold: this.voiceThreshold,
        lastRecognizedText: this.lastRecognizedText,
      };
    }

    startListening() {
      if (!this.settings.enabled) return Promise.resolve(false);
      if (this.startPromise) return this.startPromise;
      if (this.getDiagnostics().listening) return Promise.resolve(true);
      this.startPromise = this._openMicrophone().finally(() => { this.startPromise = null; });
      return this.startPromise;
    }

    async _openMicrophone() {
      const generation = ++this.listenGeneration;
      this._notifyStatus('starting', '正在连接麦克风…');
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前系统不支持麦克风音频采集');
        if (!this.mediaStream?.active) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
          });
          if (generation !== this.listenGeneration || !this.settings.enabled) {
            stream.getTracks().forEach(track => track.stop());
            return false;
          }
          this.mediaStream = stream;
        }
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (!AudioCtx) throw new Error('当前环境不支持 AudioContext');
        if (!this.audioContext || this.audioContext.state === 'closed') this.audioContext = new AudioCtx();
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();
        if (generation !== this.listenGeneration || !this.settings.enabled) return false;
        if (this.audioContext.state !== 'running') throw new Error('音频设备尚未启动，请点击麦克风测试重试');
        this.sourceNode?.disconnect();
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.3;
        this.sourceNode.connect(this.analyser);
        const track = this.mediaStream.getAudioTracks()[0];
        if (!track || track.readyState !== 'live') throw new Error('麦克风设备已断开，请连接后重试');
        track.onended = () => {
          this.stopListening();
          this._notifyStatus('error', '麦克风设备已断开，请连接后点击麦克风测试');
        };
        this.noiseFloor = 0.002;
        this._startVadMonitor();
        this._restoreStandbyStatus();
        return true;
      } catch (error) {
        if (generation !== this.listenGeneration) return false;
        const messages = {
          NotAllowedError: '麦克风权限未授予，请在系统设置中允许 Hermes / Electron 使用麦克风',
          NotFoundError: '未找到麦克风，请连接音频输入设备后重试',
          NotReadableError: '麦克风设备无法读取，可能被其他应用占用，请重试',
        };
        this.stopListening();
        this._notifyStatus('error', messages[error.name] || error.message || '麦克风启动失败');
        return false;
      }
    }

    _startVadMonitor() {
      clearInterval(this.vadTimer);
      const samples = new Float32Array(this.analyser.fftSize);
      const sensitivity = Math.max(0.1, Math.min(1, this.settings.sensitivity ?? 0.7));
      const minimum = 0.012 - sensitivity * 0.007;
      this.vadTimer = setInterval(() => {
        if (!this.analyser || this.isManualRecording || this.isProcessingCommand || this.isTranscribing) return;
        this.analyser.getFloatTimeDomainData(samples);
        this.inputLevel = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        this.voiceThreshold = Math.max(minimum, this.noiseFloor * 2.5);
        const threshold = this.isSpeaking ? this.voiceThreshold * 0.7 : this.voiceThreshold;
        if (this.inputLevel >= threshold) {
          if (global.jarvisSpeech?.isSpeaking()) this.recordedDuringPlayback = true;
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
          if (!this.isSpeaking) {
            this.isSpeaking = true;
            this._startChunkRecording();
          }
        } else {
          if (!this.isSpeaking) this.noiseFloor = this.noiseFloor * 0.95 + Math.min(this.inputLevel, minimum) * 0.05;
          if (this.isSpeaking && !this.silenceTimer) {
            this.silenceTimer = setTimeout(() => { this._stopChunkRecordingAndAnalyze(); }, 900);
          }
        }
      }, 100);
    }

    _startChunkRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') return;
      if (!this.mediaStream) return;

      try {
        this.recordedChunks = [];
        this.recordedDuringPlayback = Boolean(global.jarvisSpeech?.isSpeaking());
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
        clearTimeout(this.recordingLimitTimer);
        this.recordingLimitTimer = setTimeout(() => this._stopChunkRecordingAndAnalyze(), this.recordedDuringPlayback ? 2000 : 15000);

        if (this.status === 'woken' || this.isInActiveDialogue) {
          this._notifyStatus('recording', '正在倾听口述指令...');
        } else {
          this._notifyStatus('listening', '检测到语音输入...');
        }
      } catch (err) {
        this.isSpeaking = false;
        this._notifyStatus('error', '录音启动失败：' + err.message);
      }
    }

    _stopChunkRecordingAndAnalyze() {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      clearTimeout(this.recordingLimitTimer);
      this.recordingLimitTimer = null;
      this.isSpeaking = false;

      if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;

      const recorder = this.mediaRecorder;
      const duringPlayback = this.recordedDuringPlayback;
      this.isTranscribing = true;
      const generation = this.listenGeneration;
      recorder.onstop = async () => {
        try {
        if (generation !== this.listenGeneration) return;
        const chunks = this.recordedChunks;
        this.recordedChunks = [];
        if (!chunks || chunks.length === 0) {
          this._restoreStandbyStatus();
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        // Short wake words can produce small Opus chunks; discard only empty/nearly empty recordings.
        if (blob.size < 256) {
          this._restoreStandbyStatus();
          return;
        }

        await this._processAudioChunk(blob, duringPlayback);
        } finally {
          this.isTranscribing = false;
        }
      };

      try {
        this.mediaRecorder.stop();
      } catch (error) {
        this.isTranscribing = false;
        this._notifyStatus('error', '录音提交失败：' + error.message);
      }
    }

    _restoreStandbyStatus() {
      if (this.isInActiveDialogue) {
        this._notifyStatus('woken', '贾维斯倾听中（可直接说话，无需喊唤醒词）');
      } else {
        this._notifyStatus('listening', `贾维斯待命（喊“${this.settings.wakeWord || '贾维斯'}”对话）`);
      }
    }

    async _processAudioChunk(blob, duringPlayback = false) {
      if (this.isProcessingCommand) return;

      const generation = this.listenGeneration;
      this._notifyStatus('transcribing', '正在识别语音...');
      try {
        const res = await window.hap.transcribeAudio(await this._audioPayload(blob));

        if (generation !== this.listenGeneration) return;
        if (res && res.ok && res.text) {
          const rawText = res.text.trim();
          this.lastRecognizedText = rawText.slice(0, 140);
          this._handleTranscribedText(rawText, duringPlayback);
        } else {
          if (res?.error) this._notifyStatus('error', res.error);
          else this._restoreStandbyStatus();
        }
      } catch (err) {
        if (generation !== this.listenGeneration) return;
        this._notifyStatus('error', '语音识别失败：' + err.message);
      }
    }

    async _audioPayload(blob) {
      const settings = await global.hap.getSpeechSettings?.();
      if (settings?.asrProvider !== 'tencent') {
        return {audioBase64: await this._blobToBase64(blob), mimeType: blob.type};
      }
      // MediaRecorder emits WebM/Opus; Tencent SentenceRecognition requires WAV or another supported container.
      const context = new (global.AudioContext || global.webkitAudioContext)();
      try {
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        if (!decoded.length || decoded.duration > 60) throw new Error('单次录音请控制在 60 秒以内');
        const offline = new global.OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        const rendered = await offline.startRendering();
        const pcm = rendered.getChannelData(0);
        const buffer = new ArrayBuffer(44 + pcm.length * 2);
        const view = new DataView(buffer);
        const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
        write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
        write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, pcm.length * 2, true);
        for (let i = 0; i < pcm.length; i++) {
          const sample = Math.max(-1, Math.min(1, pcm[i]));
          view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        }
        return {audioBase64: await this._blobToBase64(new Blob([buffer], {type:'audio/wav'})), mimeType:'audio/wav'};
      } finally {
        await context.close();
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

    _handleTranscribedText(rawText, duringPlayback = false) {
      if (!rawText) {
        this._restoreStandbyStatus();
        return;
      }

      const speech = global.jarvisSpeech;
      const playing = Boolean(duringPlayback || speech?.isSpeaking());
      if (speech?.matchesRecentSpeech?.(rawText)) { this._restoreStandbyStatus(); return; }
      const matchedWake = this._matchWakeWord(rawText);
      if (playing) {
        if (/停止播报|停止播放|暂停播报|别说了|停一下|stop speaking|stop talking/i.test(rawText)) {
          speech?.cancel();
          this._startActiveDialogueWindow();
          return;
        }
        speech?.cancel();
        if (matchedWake) this._triggerWake(matchedWake, rawText);
        else this.executeCommand(rawText);
        return;
      }

      const currentWakeWord = (this.settings.wakeWord || '贾维斯').trim();
      const matched = this._matchWakeWord(rawText);

      if (this.status === 'woken' || this.isInActiveDialogue) {
        // 处于唤醒或连续对话活跃期，整句话直接作为指令执行
        const instruction = this._extractInstruction(rawText, matched || currentWakeWord) || rawText;
        this.executeCommand(instruction);
      } else if (matched) {
        // 待命状态下检测到了唤醒词
        this._triggerWake(matched, rawText);
      } else {
        this._restoreStandbyStatus();
      }
    }

    _matchWakeWord(text) {
      if (!text) return null;
      const wake = (this.settings.wakeWord || '贾维斯').trim().toLowerCase();
      const lowered = text.toLowerCase().replace(/[,.?!，。？！:：\s]/g, '');

      const wakeWords = [
        wake,
        '贾维斯',
        '贾维思',
        '加维斯',
        '嘉维斯',
        '家维斯',
        'jarvis',
        '小赫',
        'hermes',
        '小爱',
        '小艾',
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
      this._notifyStatus('woken', `已唤醒 [${matchedWord}]`);

      for (const fn of this.wakeListeners) {
        try {
          fn(matchedWord);
        } catch (e) {
          console.error(e);
        }
      }

      const inlineInstruction = this._extractInstruction(fullSentence, matchedWord);
      if (inlineInstruction && inlineInstruction.length >= 2) {
        // 连贯口述：“贾维斯 帮我看看屏幕”
        this.executeCommand(inlineInstruction);
      } else {
        if (global.jarvisSpeech) void global.jarvisSpeech.speakGreeting(matchedWord);
        // 仅说了唤醒词，开启 10 秒连续倾听窗口
        this._startActiveDialogueWindow();
      }
    }

    _startActiveDialogueWindow() {
      clearTimeout(this.activeDialogueTimer);
      this.isInActiveDialogue = true;
      this._notifyStatus('woken', '贾维斯倾听中（可直接说话，无需喊唤醒词）');

      this.activeDialogueTimer = setTimeout(() => {
        this.isInActiveDialogue = false;
        if (this.status === 'woken') {
          this._notifyStatus('listening', `贾维斯待命（喊“${this.settings.wakeWord || '贾维斯'}”对话）`);
        }
      }, 10000); // 10 秒自然连续对话活跃期
    }

    /**
     * 判断是否为屏幕视觉感知指令
     */
    _isScreenVisionCommand(text) {
      const lower = text.toLowerCase();
      return (
        /看(看|下)?(当前)?(屏幕|报错|画面|代码|显示器)/.test(lower) ||
        /截屏|截图/.test(lower) ||
        /look at (my |the )?screen/i.test(lower) ||
        /analyze (my |the )?screen/i.test(lower) ||
        /what'?s on my screen/i.test(lower)
      );
    }

    /**
     * 系统级原生控制快车道 (<50ms 执行，避免走慢速大模型)
     */
    async _checkFastSystemControl(text) {
      const lower = text.trim().toLowerCase();

      // 1. 时间/日期查询
      if (/几点|现在时间|当前时间|what time/i.test(lower)) {
        return window.hap?.systemControl?.({ action: 'get_time' });
      }

      // 2. 音量增加
      if (/调大音量|增大音量|提高音量|声音大点|音量调高|volume up/i.test(lower)) {
        return window.hap?.systemControl?.({ action: 'volume_up' });
      }

      // 3. 音量降低
      if (/调小音量|减小音量|降低音量|声音小点|音量调低|volume down/i.test(lower)) {
        return window.hap?.systemControl?.({ action: 'volume_down' });
      }

      // 4. 静音 / 恢复声音
      if (/静音|闭嘴|恢复声音|取消静音|mute/i.test(lower)) {
        return window.hap?.systemControl?.({ action: 'volume_mute' });
      }

      // 5. 锁屏
      if (/锁定屏幕|锁屏|休眠屏幕|lock screen/i.test(lower)) {
        return window.hap?.systemControl?.({ action: 'lock_screen' });
      }

      // 6. 快捷启动常用软件
      const appMatch = lower.match(/打开\s*(谷歌浏览器|chrome|safari|vscode|代码编辑器|终端|网易云音乐|terminal)/i);
      if (appMatch) {
        const rawApp = appMatch[1].toLowerCase();
        let appName = 'Google Chrome';
        if (rawApp.includes('chrome') || rawApp.includes('谷歌')) appName = 'Google Chrome';
        else if (rawApp.includes('safari')) appName = 'Safari';
        else if (rawApp.includes('vscode') || rawApp.includes('代码')) appName = 'Visual Studio Code';
        else if (rawApp.includes('终端') || rawApp.includes('terminal')) appName = 'Terminal';
        else if (rawApp.includes('音乐')) appName = 'NeteaseMusic';
        return window.hap?.systemControl?.({ action: 'open_app', param: appName });
      }

      return null;
    }

    async executeCommand(instructionText) {
      const text = instructionText.trim();
      if (!text || this.isProcessingCommand) return;
      this.isProcessingCommand = true;
      clearTimeout(this.silenceTimer);
      clearTimeout(this.activeDialogueTimer);

      this._notifyStatus('executing', `指令: "${text}"`);

      for (const fn of this.commandListeners) {
        try {
          fn(text);
        } catch (e) {
          console.error(e);
        }
      }

      try {
        if (!this.settings.autoExecute) {
          this._notifyStatus('idle', `已识别口述: "${text}"`);
          this.isProcessingCommand = false;
          return;
        }

        // ==========================================
        // 阶段 1：优先匹配系统级快车道 (<50ms)
        // ==========================================
        const fastResult = await this._checkFastSystemControl(text);
        if (fastResult && fastResult.ok) {
          const msg = fastResult.message || '操作已执行完成，先生。';
          this._notifyStatus('idle', msg);
          if (global.jarvisSpeech) {
            void global.jarvisSpeech.speakFastAction(msg);
          }
          for (const fn of this.resultListeners) {
            try {
              fn({ ok: true, instruction: text, reply: msg });
            } catch (e) {
              console.error(e);
            }
          }
          this._startActiveDialogueWindow();
          this.isProcessingCommand = false;
          return;
        }

        // ==========================================
        // 阶段 2：屏幕视觉感知 (Screen Vision)
        // ==========================================
        if (this._isScreenVisionCommand(text)) {
          this._notifyStatus('executing', '正在捕获屏幕画面分析中...');
          if (global.jarvisSpeech) {
            void global.jarvisSpeech.speakActionAck(text);
          }

          let reply = '';
          try {
            const cap = await window.hap?.captureScreen?.();
            const hasScreen = cap && cap.ok && cap.data;
            const visionPrompt = hasScreen
              ? `[贾维斯视觉感知·当前屏幕画面已捕获] 用户的口述指令为："${text}"。\n请扮演钢铁侠的 AI 管家贾维斯(J.A.R.V.I.S.)。请基于当前捕获的屏幕内容进行详尽观察与诊断，分析屏幕代码、界面元素或报错日志，尊称用户为“先生(Sir)”，给出清晰利落的解决指导。`
              : `[贾维斯管家] 用户的口述指令为："${text}"。请扮演托尼·斯塔克的 AI 管家贾维斯，尊称用户为“先生”，进行解答。`;

            if (window.hap?.chat) {
              const res = await window.hap.chat({
                input: visionPrompt,
                sessionKey: 'voice_wake_session',
              });
              const outcomeText = res?.outcome?.text || res?.output || (typeof res === 'string' ? res : '');
              reply = outcomeText || '屏幕内容已完成分析，先生。';
            } else {
              reply = '已捕获屏幕并完成分析，先生。';
            }

            this._notifyStatus('idle', `分析完成: ${reply.slice(0, 36)}...`);
            if (global.jarvisSpeech) {
              void global.jarvisSpeech.speakSummary(reply);
            }
            for (const fn of this.resultListeners) {
              try {
                fn({ ok: true, instruction: text, reply });
              } catch (e) {
                console.error(e);
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this._notifyStatus('idle', `视觉分析异常: ${errMsg}`);
            if (global.jarvisSpeech) {
              void global.jarvisSpeech.speakSummary(errMsg, true);
            }
            for (const fn of this.resultListeners) {
              try {
                fn({ ok: false, instruction: text, error: errMsg });
              } catch (e) {
                console.error(e);
              }
            }
          } finally {
            this._startActiveDialogueWindow();
            this.isProcessingCommand = false;
          }
          return;
        }

        // ==========================================
        // 阶段 3：通用 Agent 智能体调用（注入管家人格）
        // ==========================================
        if (global.jarvisSpeech) {
          void global.jarvisSpeech.speakActionAck(text);
        }

        const jarvisPrompt = this.settings.jarvisMode
          ? `[系统设定: 托尼·斯塔克的AI管家贾维斯(J.A.R.V.I.S.)。称呼用户为“先生(Sir)”，语气严谨沉稳、彬彬有礼、高效利落。]\n用户指令: "${text}"`
          : text;

        let reply = '';
        if (window.hap?.chat) {
          const res = await window.hap.chat({
            input: jarvisPrompt,
            sessionKey: 'voice_wake_session',
          });

          const outcomeText = res?.outcome?.text || res?.output || (typeof res === 'string' ? res : '');
          reply = outcomeText || '指令已成功派发执行完成，先生。';
        } else {
          reply = `已接收并处理指令: ${text}`;
        }

        this._notifyStatus('idle', `完成: ${reply.slice(0, 36)}...`);

        // 口述提炼执行结果
        if (global.jarvisSpeech) {
          void global.jarvisSpeech.speakSummary(reply);
        }

        for (const fn of this.resultListeners) {
          try {
            fn({ ok: true, instruction: text, reply });
          } catch (e) {
            console.error(e);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this._notifyStatus('idle', `异常: ${errMsg}`);
        if (global.jarvisSpeech) {
          void global.jarvisSpeech.speakSummary(errMsg, true);
        }
        for (const fn of this.resultListeners) {
          try {
            fn({ ok: false, instruction: text, error: errMsg });
          } catch (e) {
            console.error(e);
          }
        }
      } finally {
        this.isProcessingCommand = false;
        this._startActiveDialogueWindow();
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
        clearTimeout(this.recordingLimitTimer);
        this.recordingLimitTimer = setTimeout(() => this._stopChunkRecordingAndAnalyze(), 15000);
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
            const res = await window.hap.transcribeAudio(await this._audioPayload(blob));

            if (res && res.ok && res.text) {
              const text = res.text.trim();
              resolve(text);
              await this.executeCommand(text);
            } else {
              const err = res?.error || '未识别到有效语音，请检查语音设置中的识别服务和凭据';
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
      this.listenGeneration++;
      clearTimeout(this.recordingLimitTimer);
      this.recordingLimitTimer = null;
      clearInterval(this.vadTimer);
      clearTimeout(this.silenceTimer);
      clearTimeout(this.wakeStateTimer);
      clearTimeout(this.activeDialogueTimer);
      this.vadTimer = null;
      this.silenceTimer = null;

      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        try {
          this.mediaRecorder.onstop = null;
          this.mediaRecorder.stop();
        } catch (_) {}
      }
      this.mediaRecorder = null;
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch (_) {}
      }
      if (this.analyser) {
        try {
          this.analyser.disconnect();
        } catch (_) {}
      }
      if (this.mediaStream) {
        try {
          this.mediaStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
        } catch (_) {}
        this.mediaStream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        try {
          this.audioContext.close().catch(() => {});
        } catch (_) {}
        this.audioContext = null;
      }
      this.sourceNode = null;
      this.analyser = null;
      this.inputLevel = 0;
      this.isTranscribing = false;
      this.isSpeaking = false;
      this.isManualRecording = false;
      this.isProcessingCommand = false;
      this.isInActiveDialogue = false;
      this._notifyStatus('idle', '语音监听已关闭');
    }

    async updateSettings(patch) {
      if (window.hap?.updateVoiceWakeSettings) await window.hap.updateVoiceWakeSettings({ ...this.settings, ...patch });
      this.settings = { ...this.settings, ...patch };
      if (global.jarvisSpeech) {
        global.jarvisSpeech.configure(this.settings);
      }
      if (patch.enabled === false) this.stopListening();
      else if (patch.enabled === true) await this.startListening();
      if (window.hap?.broadcastVoiceWake) {
        try {
          await window.hap.broadcastVoiceWake({
            type: 'settings_updated',
            settings: this.settings,
          });
        } catch (_) {}
      }
    }
  }

  global.voiceWakeController = new VoiceWakeController();
})(typeof window !== 'undefined' ? window : globalThis);
