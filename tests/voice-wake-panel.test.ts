import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
const source = readFileSync('src/gui/renderer/app.js', 'utf8');
function setup(listening: boolean, detail = '') {
  vi.useFakeTimers();
  const elements: Record<string, any> = {};
  for (const id of ['voiceWakeStatusBadge', 'voiceWakeStatusText', 'voiceWakeDetailText', 'voiceWakeInputMeter']) elements[id] = { style: {}, textContent: '', value: 0 };
  const diagnostics = { listening, status: listening ? 'listening' : 'error', detail, level: 0.003, microphone: 'USB mic', lastRecognizedText: '' };
  const controller = { settings: { enabled: true, wakeWord: '贾维斯' }, startListening: vi.fn().mockResolvedValue(listening), getDiagnostics: () => diagnostics,
    playWakeChime: vi.fn(), onStatusChange: vi.fn() };
  const window: any = { voiceWakeController: controller };
  const showToast = vi.fn();
  runInNewContext(source.slice(source.indexOf('window.testVoiceWakeMic ='), source.indexOf('window.switchProviderModelView =')), { window, $: (id: string) => elements[id], showToast, setTimeout, setInterval });
  return { window, elements, showToast, diagnostics };
}
afterEach(() => vi.useRealTimers());
describe('voice microphone status panel', () => {
  it('reports failed microphone startup without a timed success message', async () => {
    const h = setup(false, '麦克风权限未授予'); await h.window.testVoiceWakeMic({ disabled: false }); await vi.advanceTimersByTimeAsync(3000);
    expect(h.showToast.mock.calls.some(c => c[1] === 'success')).toBe(false);
    expect(h.elements.voiceWakeStatusText.textContent).toBe('监听异常');
    expect(h.elements.voiceWakeDetailText.textContent).toContain('权限');
  });
  it('keeps the actual listening state visible after microphone test completes', async () => {
    const h = setup(true); await h.window.testVoiceWakeMic({ disabled: false }); await vi.advanceTimersByTimeAsync(3000);
    expect(h.elements.voiceWakeStatusText.textContent).toBe('监听中');
  });
});
