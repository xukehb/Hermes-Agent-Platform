# Jarvis Tencent TTS Implementation Plan

**Goal:** Repair provider/model saves and make Tencent Cloud speech available from Jarvis settings.

**Architecture:** Keep cloud credentials in a separate permission-restricted local file. A small SpeechService validates configuration, signs TextToVoice calls in the main process, and exposes public configuration and audio through Electron IPC and authenticated web routes. Renderer owns cancellable playback and optional local fallback.

**Tech Stack:** TypeScript, Node crypto/fetch, Electron IPC, Hono, browser Audio, Vitest.

- [x] Reproduce provider save failures, stale selectors, lost metadata and alias conflicts; add behavioral regression tests and repair.
- [x] Reproduce cancellation and voice-selection defects in local Jarvis speech; repair with lifecycle tests.
- [x] Add SpeechService tests for credentials, validation, TC3 requests and cloud errors; run red, implement, run green.
- [x] Wire get/save/synthesize APIs in desktop and web; add labelled settings controls and audition.
- [x] Implement cancellable cloud playback, stale-result suppression, error feedback and optional local fallback; add tests.
- [x] Run focused tests, typecheck, build and isolated browser configuration/save/refresh checks. Cloud acceptance requires a user-supplied enabled Tencent account.

Reference: https://cloud.tencent.com/document/product/1073/37995 (TextToVoice), https://cloud.tencent.com/document/api/213/30654 (TC3 signing).

Validation: 95 test files / 1014 tests passed; typecheck, build, renderer ESLint and generated dictionary check passed. Isolated web checks verified provider/model visibility after saving with a stale search filter, speech setting persistence, and missing-credential audition feedback. Real Tencent account synthesis and physical microphone acceptance remain user-side checks.

## 后续语音链路修复（2026-10-20）

- [x] 接入腾讯云 ASR，录音转换为 16kHz 单声道 PCM WAV，保留原有模型路径。
- [x] 修复底噪触发、静音计时器状态、启动竞争、停止后的迟到请求和麦克风错误提示。
- [x] 显示真实监听状态、输入电平和最近识别内容，避免测试按钮误报成功。
- [x] 避免扬声器回声按音量直接取消播报，识别到新用户话语时仍可直接打断，无需唤醒词。
- [x] 增加男声音色预设、情感类型及强度校验，凭据始终仅保存在本机。
- [x] 去掉 130 字及 1200 字截断；以每段不超过 140 字连续播报全部正文。
- [x] 回归测试覆盖 131、141、1201、3000 字及完整分段播放链路。

桌面验证：真实腾讯云合成及识别通过；注入播报音频的回声测试完整播完、无误执行，直接插话测试无需唤醒词即可中断；用户确认真实麦克风喊唤醒词能收到回应。最初 1014 项测试的记录对应早期 TTS 阶段；当前版本另执行全量测试、类型检查与构建。
