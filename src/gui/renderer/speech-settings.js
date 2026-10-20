(function (global) {
  const form = document.getElementById('speechSettingsForm');
  if (!form) return;
  const field = (name) => document.getElementById(`speech${name}`);
  const status = document.getElementById('speechPlaybackStatus');
  const saveButton = document.getElementById('saveSpeechSettingsBtn');
  const testButton = document.getElementById('testSpeechSettingsBtn');
  let busy = false;

  function render(settings) {
    for (const [name, key] of [['AsrProvider', 'asrProvider'], ['AsrEngine', 'asrEngine'], ['Provider', 'provider'], ['Region', 'region'], ['VoiceType', 'voiceType'], ['Speed', 'speed'], ['Volume', 'volume'], ['EmotionCategory', 'emotionCategory'], ['EmotionIntensity', 'emotionIntensity']]) {
      field(name).value = settings[key];
    }
    field('VoicePreset').value = ['101004','601008','603006'].includes(String(settings.voiceType)) ? String(settings.voiceType) : '';
    field('Fallback').checked = settings.fallbackToLocal;
    field('SecretId').value = '';
    field('SecretKey').value = '';
    document.getElementById('speechCredentialStatus').textContent = settings.credentialsConfigured
      ? '腾讯云凭据已配置；密钥输入框留空可保留原值。' : '腾讯云凭据尚未配置；本地系统语音可直接使用。';
  }

  async function save(audition) {
    if (busy || !form.reportValidity()) return;
    busy = true;
    saveButton.disabled = true;
    testButton.disabled = true;
    status.textContent = '正在保存…';
    try {
      if (!global.hap?.saveSpeechSettings) throw new Error('当前环境不支持保存语音设置');
      const settings = await global.hap.saveSpeechSettings({
        asrProvider: field('AsrProvider').value, asrEngine: field('AsrEngine').value,
        provider: field('Provider').value, region: field('Region').value.trim(),
        voiceType: Number(field('VoiceType').value), emotionCategory: field('EmotionCategory').value, emotionIntensity: Number(field('EmotionIntensity').value), speed: Number(field('Speed').value), volume: Number(field('Volume').value),
        secretId: field('SecretId').value, secretKey: field('SecretKey').value, fallbackToLocal: field('Fallback').checked,
      });
      render(settings);
      global.jarvisSpeech.cancel();
      global.jarvisSpeech.cloudSettings = settings;
      await global.hap.broadcastVoiceWake?.({ type: 'speech_settings_updated' });
      status.textContent = '语音设置已保存';
      if (audition) {
        status.textContent = settings.provider === 'tencent' ? '正在合成并播放腾讯云语音…' : '正在播放本地系统语音…';
        // Audition is independent of the automatic reply switch.
        const ok = await global.jarvisSpeech.speak('先生，贾维斯已就绪，随时为您效劳。', { preview: true });
        if (status.textContent.includes('正在')) status.textContent = ok ? '试听完成' : '播报已停止或无法播放';
      }
    } catch (error) {
      status.textContent = `语音设置失败：${error.message}`;
    } finally {
      busy = false;
      saveButton.disabled = false;
      testButton.disabled = false;
    }
  }

  field('VoicePreset').addEventListener('change', () => {
    if (!field('VoicePreset').value) return;
    field('VoiceType').value = field('VoicePreset').value;
    field('EmotionCategory').value = field('VoicePreset').value === '601008' ? 'peaceful' : '';
    field('EmotionIntensity').value = '90';
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); void save(false); });
  testButton.addEventListener('click', () => { void save(true); });
  document.getElementById('stopSpeechTestBtn').addEventListener('click', () => {
    global.jarvisSpeech.cancel();
    status.textContent = '播报已停止';
  });
  global.addEventListener('jarvis-speech-error', (event) => {
    status.textContent = `${event.detail.message}${event.detail.fallback ? '；已尝试使用本地语音' : ''}`;
  });
  if (global.hap?.getSpeechSettings) {
    global.hap.getSpeechSettings().then(render).catch((error) => {
      document.getElementById('speechCredentialStatus').textContent = `读取语音设置失败：${error.message}`;
    });
  } else {
    document.getElementById('speechCredentialStatus').textContent = '当前环境暂不支持云语音配置';
  }
})(window);
