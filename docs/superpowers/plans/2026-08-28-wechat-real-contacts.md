# WeChat Real Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect personal WeChat through a configured Wechaty Puppet service and let users configure replies for real contacts and rooms.

**Architecture:** A `WechatyPersonalDriver` replaces the simulated personal driver. It maps Wechaty events into the existing `WeChatChannel` and `WeChatContactStore`; the GUI obtains sync status through Electron IPC.

**Tech Stack:** TypeScript, Electron IPC, Vitest, Wechaty 1.20.2, wechaty-puppet-service 1.18.2.

---

### Task 1: Personal Puppet configuration

**Files:** `package.json`, `src/config/schema.ts`, `src/config/defaults.ts`, `src/config/resolved.ts`, `src/config/resolver.ts`, `tests/config.test.ts`

- [ ] Write a failing resolver test for `[channels.wechat.personal]` that expects `puppet: 'service'`, `puppetServiceTokenEnv: 'WECHATY_PUPPET_SERVICE_TOKEN'`, and an optional endpoint.
- [ ] Run `npm test -- tests/config.test.ts` and confirm the new test fails.
- [ ] Install exact runtime dependencies with `npm install wechaty@1.20.2 wechaty-puppet-service@1.18.2`.
- [ ] Add `wechatPersonalSchema` with `puppet`, `puppet_service_token_env`, and `puppet_service_endpoint`; add the matching resolved type and resolver/default mappings. The token remains in an environment variable.
- [ ] Run `npm test -- tests/config.test.ts; npm run typecheck` and confirm both exit 0.

### Task 2: Wechaty driver

**Files:** Create `src/channels/wechat/wechaty-personal-driver.ts`; modify `src/channels/wechat.ts`, `src/channels/index.ts`; test `tests/wechat-personal-driver.test.ts`

- [ ] Write failing tests using a small injected Wechaty facade. Assert missing Puppet token rejects startup with the configured environment variable name; assert login and message events expose real stable ids and names.
- [ ] Run `npm test -- tests/wechat-personal-driver.test.ts` and confirm it fails because `WechatyPersonalDriver` is absent.
- [ ] Implement `WechatyPersonalDriver` with the service Puppet. On login call `onLogin({ id: contact.id, name: contact.name() })`; map message talker, room, room topic, id, and text into the existing callback shape. Implement `sendMessage` by resolving Contact then Room and throw when target is absent.
- [ ] Replace `DefaultPersonalDriver`, including its fixed `wx_user_self` session and log-only send implementation.
- [ ] Run `npm test -- tests/wechat-personal-driver.test.ts; npm run typecheck` and confirm both exit 0.

### Task 3: Contact and room synchronization

**Files:** Modify `src/channels/wechat/wechaty-personal-driver.ts`, `src/channels/wechat-contacts.ts`, `src/channels/wechat.ts`; test `tests/wechat-contacts.test.ts`, `tests/wechat-personal-driver.test.ts`

- [ ] Write failing tests that sync fixture `wx-contact-1` and `wx-room-1`, preserve an existing `agentId: 'reviewer'` and `replyMode: 'manual'`, and retain records absent from a later sync.
- [ ] Run `npm test -- tests/wechat-contacts.test.ts tests/wechat-personal-driver.test.ts` and confirm the new tests fail.
- [ ] Add `syncContacts()` to the driver using `Contact.findAll()` and `Room.findAll()`. Add optional `lastSyncedAt` and `lastSeenAt` fields. Upsert identity fields while merging, rather than replacing, the stored reply rule.
- [ ] Have `WeChatChannel` synchronize once after a successful login and expose `syncPersonalContacts()` only for personal mode.
- [ ] Run `npm test -- tests/wechat-contacts.test.ts tests/wechat-personal-driver.test.ts` and confirm all pass.

### Task 4: Service and IPC

**Files:** Modify `src/gui/service.ts`, `src/gui/main.ts`, `src/gui/renderer/preload.cjs`, `src/gui/shared.ts`; test `tests/gui-service-wechat.test.ts`

- [ ] Write failing tests for `syncWeChatContacts()`, including stopped service and non-personal-mode failure cases, plus a successful summary with contact count, room count, last sync, and error.
- [ ] Run `npm test -- tests/gui-service-wechat.test.ts` and confirm it fails.
- [ ] Implement `syncWeChatContacts`, register `gui:syncWeChatContacts`, and expose it from preload. Add `syncStatus` to GUI config with `lastSyncedAt`, `contactCount`, `roomCount`, and optional `error`.
- [ ] Run `npm test -- tests/gui-service-wechat.test.ts; npm run typecheck` and confirm both exit 0.

### Task 5: GUI and documentation

**Files:** Modify `src/gui/renderer/index.html`, `src/gui/renderer/app.js`, `src/gui/renderer/styles.css`, `README.md`; test `tests/gui-wechat-view.test.ts`

- [ ] Write a failing view test expecting a `同步联系人和群聊` action, sync diagnostics, and no manual-add action for personal WeChat.
- [ ] Run `npm test -- tests/gui-wechat-view.test.ts` and confirm it fails.
- [ ] Add a status row for login user, last synchronization, real contact count, room count, and diagnostics. Replace manual personal-WeChat contact creation with a sync action; retain existing per-contact agent and reply-mode settings.
- [ ] Document the Puppet token environment variable and state that no simulated contacts are displayed when it is absent.
- [ ] Run `npm test -- tests/gui-wechat-view.test.ts; npm run build` and confirm both exit 0.

### Task 6: Full verification

- [ ] Run `npm test; npm run typecheck; npm run build; git diff --check`.
- [ ] Confirm every command exits 0, then commit only files belonging to this feature with message `feat: sync real wechat contacts through wechaty`.
