import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/gui/renderer/voice-wake.js', 'utf8');
async function setup() {
  vi.useFakeTimers();
  const input = { rms: 0.001, frequency: 0 };
  const track = { readyState: 'live', enabled: true, muted: false, label: 'Test microphone', stop: vi.fn(), onended: null };
  const stream = { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const recordings: any[] = [];
  const analyser = { fftSize: 512, frequencyBinCount: 256, smoothingTimeConstant: 0,
    getByteFrequencyData: (data: Uint8Array) => data.fill(input.frequency),
    getFloatTimeDomainData: (data: Float32Array) => data.fill(input.rms), disconnect: vi.fn() };
  class AudioContext {
    state = 'running'; resume = vi.fn().mockResolvedValue(undefined);
    close = vi.fn(async () => { this.state = 'closed'; });
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable: any; onstop: any;
    constructor() { recordings.push(this); }
    start() { this.state = 'recording'; }
    stop = vi.fn(() => {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['x'.repeat(5000)]) });
      void this.onstop?.();
    });
  }
  const window: any = { AudioContext, hap: { getVoiceWakeSettings: () => ({ enabled: false }) } };
  runInNewContext(source, { window, navigator: { mediaDevices: { getUserMedia } }, MediaRecorder: Recorder,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Blob, console });
  await Promise.resolve(); await Promise.resolve();
  const controller = window.voiceWakeController;
  controller.settings.enabled = true;
  controller._processAudioChunk = vi.fn().mockResolvedValue(undefined);
  return { controller, input, track, stream, getUserMedia, recordings, window };
}
afterEach(() => { vi.useRealTimers(); });

describe('voice wake microphone and speech boundaries', () => {
  it('does not mistake a noisy frequency floor for speech', async () => {
    const h = await setup(); h.input.rms = 0.003; h.input.frequency = 30;
    await h.controller.startListening(); await vi.advanceTimersByTimeAsync(2200);
    expect(h.recordings).toHaveLength(0);
  });
  it('submits speech after a pause followed by more speech and a final silence', async () => {
    const h = await setup(); await h.controller.startListening();
    h.input.rms = 0.04; h.input.frequency = 80; await vi.advanceTimersByTimeAsync(300);
    h.input.rms = 0.001; h.input.frequency = 0; await vi.advanceTimersByTimeAsync(500);
    h.input.rms = 0.04; h.input.frequency = 80; await vi.advanceTimersByTimeAsync(300);
    h.input.rms = 0.001; h.input.frequency = 0; await vi.advanceTimersByTimeAsync(1600);
    expect(h.controller._processAudioChunk).toHaveBeenCalledOnce();
  });
  it('bounds a recording when the microphone never becomes silent', async () => {
    const h = await setup(); await h.controller.startListening();
    h.input.rms = 0.04; h.input.frequency = 80; await vi.advanceTimersByTimeAsync(16200);
    expect(h.controller._processAudioChunk).toHaveBeenCalled();
  });
  it('serializes concurrent microphone startup attempts', async () => {
    const h = await setup(); await Promise.all([h.controller.startListening(), h.controller.startListening()]);
    expect(h.getUserMedia).toHaveBeenCalledOnce();
  });
  it('releases a microphone obtained after listening was stopped', async () => {
    const h = await setup(); let release: (stream: unknown) => void = () => {};
    h.getUserMedia.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = h.controller.startListening(); h.controller.stopListening(); release(h.stream); await pending;
    expect(h.track.stop).toHaveBeenCalled(); expect(h.controller.mediaStream).toBeNull();
  });
  it('reports permission denial without claiming the microphone is ready', async () => {
    const h = await setup(); h.getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    expect(await h.controller.startListening()).toBe(false);
    expect(h.controller.status).toBe('error'); expect(h.controller.statusDetail).toContain('权限');
  });
  it('retains the actual startup diagnostic for newly attached UI subscribers', async () => {
    const h = await setup(); h.controller._notifyStatus('error', '麦克风权限未授予');
    const listener = vi.fn(); h.controller.onStatusChange(listener);
    expect(listener).toHaveBeenCalledWith('error', '麦克风权限未授予');
  });
  it('recognizes common ASR homophones of Jarvis', async () => {
    const { controller } = await setup(); expect(controller._matchWakeWord('加维斯，你好。')).toBe('加维斯');
  });
});


describe('speaker echo and deliberate interruption', () => {
  it('does not cancel playback merely because the microphone detects sound', async () => {
    const h = await setup(); const cancel = vi.fn();
    h.window.jarvisSpeech = { isSpeaking: () => true, cancel };
    await h.controller.startListening(); h.input.rms = 0.04; h.input.frequency = 80;
    await vi.advanceTimersByTimeAsync(500); expect(cancel).not.toHaveBeenCalled();
  });
  it('does not execute ordinary playback echo as a follow-up command', async () => {
    const h = await setup(); h.controller.isInActiveDialogue = true; h.controller.executeCommand = vi.fn();
    h.window.jarvisSpeech = { isSpeaking: () => true, matchesRecentSpeech: () => true, cancel: vi.fn() };
    h.controller._handleTranscribedText('先生，我正在为您汇报执行结果。', true);
    expect(h.controller.executeCommand).not.toHaveBeenCalled();
  });
  it('ignores recognized output even if the output mentions the wake word', async () => {
    const h = await setup(); h.controller._triggerWake = vi.fn();
    h.window.jarvisSpeech = { isSpeaking: () => true, matchesRecentSpeech: () => true, cancel: vi.fn() };
    h.controller._handleTranscribedText('先生，贾维斯已经准备就绪。', true);
    expect(h.controller._triggerWake).not.toHaveBeenCalled();
  });
  it('accepts an explicit wake word to interrupt a reply', async () => {
    const h = await setup(); h.controller._triggerWake = vi.fn();
    h.window.jarvisSpeech = { isSpeaking: () => true, matchesRecentSpeech: () => false, cancel: vi.fn() };
    h.controller._handleTranscribedText('贾维斯，换个话题。', true);
    expect(h.window.jarvisSpeech.cancel).toHaveBeenCalledOnce();
    expect(h.controller._triggerWake).toHaveBeenCalledWith('贾维斯', '贾维斯，换个话题。');
  });
});


it('lets a new spoken instruction interrupt playback without a wake word', async () => {
  const h = await setup(); h.controller.executeCommand = vi.fn();
  h.window.jarvisSpeech = { isSpeaking: () => true, matchesRecentSpeech: () => false, cancel: vi.fn() };
  h.controller._handleTranscribedText('帮我查看当前时间。', true);
  expect(h.window.jarvisSpeech.cancel).toHaveBeenCalledOnce();
  expect(h.controller.executeCommand).toHaveBeenCalledWith('帮我查看当前时间。');
});
