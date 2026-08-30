# WeChat iLink Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native multi-account Tencent iLink QR authentication, durable message sync, real replies, reconnection and account-scoped GUI controls.

**Architecture:** Isolate raw protocol, credential persistence, login state and message monitoring into focused modules under `src/channels/wechat/ilink`. Expose the driver through the approved control-plane runtime adapter so every account inherits one-server binding and operator authorization.

**Tech Stack:** TypeScript 7, Node.js fetch/AbortController, Zod 4, Electron IPC, existing browser QR renderer, Vitest

---

## File Map

- `src/channels/wechat/ilink/types.ts`: protocol schemas and safe error types.
- `src/channels/wechat/ilink/api-client.ts`: HTTP headers, endpoints, validation and aborts.
- `src/channels/wechat/ilink/credential-store.ts`: account-scoped login, cursor, context and dedupe state.
- `src/channels/wechat/ilink/login-session.ts`: QR state machine.
- `src/channels/wechat/ilink/driver.ts`: start/stop/reconnect/getupdates/sendmessage.
- `src/channels/wechat/ilink/index.ts`: public exports.
- `src/channels/wechat.ts`: select legacy or native driver without fake sessions.
- `src/control-plane/platform-adapters.ts`: construct one iLink runtime per account.
- `src/config/schema.ts`, `src/config/defaults.ts`, `src/config/resolved.ts`: CLI compatibility mode.
- `src/gui/shared.ts`, `src/gui/service.ts`, `src/gui/main.ts`, `src/gui/renderer/preload.cjs`: account-scoped QR IPC.
- `src/gui/renderer/index.html`, `src/gui/renderer/app.js`, `src/gui/renderer/styles.css`: QR/verification/runtime states.
- `tests/wechat-ilink-*.test.ts`, `tests/channels-wechat.test.ts`, `tests/renderer-ui.test.ts`: coverage.

### Task 1: Lock protocol contracts with fixtures

**Files:**
- Create: `src/channels/wechat/ilink/types.ts`
- Create: `src/channels/wechat/ilink/index.ts`
- Create: `tests/fixtures/wechat-ilink/*.json`
- Create: `tests/wechat-ilink-types.test.ts`

- [ ] **Step 1: Add failing fixture tests for every terminal QR state and message response**

```ts
it.each(['wait', 'scaned', 'need_verifycode', 'verify_code_blocked', 'confirmed', 'expired',
  'scaned_but_redirect', 'binded_redirect'])(
  'parses QR state %s', (status) => {
    expect(parseQrStatus(fixture(`qr-${status}.json`)).status).toBe(status);
  },
);

it('rejects a confirmed response without token and baseurl', () => {
  expect(() => parseQrStatus({ status: 'confirmed', bot_token: '' })).toThrow(/ILINK_SCHEMA/);
});
```

- [ ] **Step 2: Run and verify the parser is missing**

Run: `npx vitest run tests/wechat-ilink-types.test.ts`

Expected: FAIL because `parseQrStatus` does not exist.

- [ ] **Step 3: Implement strict schemas and redacted errors**

```ts
export const qrStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('wait') }),
  z.strictObject({ status: z.literal('scaned') }),
  z.strictObject({ status: z.literal('expired') }),
  z.strictObject({ status: z.literal('confirmed'), bot_token: z.string().min(1),
    ilink_bot_id: z.string().min(1), ilink_user_id: z.string().min(1).optional(),
    baseurl: z.string().url() }),
  z.strictObject({ status: z.literal('need_verifycode') }),
  z.strictObject({ status: z.literal('verify_code_blocked') }),
  z.strictObject({ status: z.literal('scaned_but_redirect'), redirect_host: z.string().min(1) }),
  z.strictObject({ status: z.literal('binded_redirect') }),
]);
```

Add schemas for QR creation, update batches, text messages, sync cursors and send responses. Safe errors contain only code, endpoint label and HTTP status.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/wechat-ilink-types.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(wechat): define iLink protocol contracts"`

### Task 2: Implement the hardened iLink API client

**Files:**
- Create: `src/channels/wechat/ilink/api-client.ts`
- Test: `tests/wechat-ilink-api.test.ts`

- [ ] **Step 1: Write failing request and SSRF tests**

```ts
it('sends required client headers without bearer before login', async () => {
  await client.createQr();
  expect(fetchMock.lastHeaders()).toMatchObject({
    'iLink-App-Id': 'bot', AuthorizationType: 'ilink_bot_token',
  });
  expect(fetchMock.lastHeaders().Authorization).toBeUndefined();
});

it('rejects non-HTTPS and non-Weixin redirect hosts', () => {
  expect(() => validateIlinkBaseUrl('http://127.0.0.1:3000')).toThrow(/ILINK_BASEURL/);
  expect(() => validateIlinkBaseUrl('https://evil.example')).toThrow(/ILINK_BASEURL/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/wechat-ilink-api.test.ts`

Expected: FAIL because the API client is missing.

- [ ] **Step 3: Implement the six endpoints with injected fetch**

```ts
private async request<T>(spec: RequestSpec<T>): Promise<T> {
  const response = await this.fetch(new URL(spec.path, this.baseUrl), {
    method: spec.method,
    headers: this.headers(spec.authenticated),
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal: spec.signal,
  });
  if (!response.ok) throw IlinkError.http(spec.label, response.status);
  return spec.schema.parse(await response.json());
}
```

Use the exact documented POST/GET methods, send up to ten recent local account tokens in
`local_token_list`, random uint32 base64 `X-WECHAT-UIN`, package-derived client version, bearer only after
login, and HTTPS `weixin.qq.com` subdomain validation.

- [ ] **Step 4: Verify timeouts, abort and safe errors; commit**

Run: `npx vitest run tests/wechat-ilink-api.test.ts`

Expected: PASS and no error snapshot contains token, QR query or raw response body.

Commit: `git commit -m "feat(wechat): add native iLink API client"`

### Task 3: Persist account state atomically

**Files:**
- Create: `src/channels/wechat/ilink/credential-store.ts`
- Test: `tests/wechat-ilink-store.test.ts`

- [ ] **Step 1: Write failing isolation, mode and corruption tests**

```ts
it('isolates context tokens by account and peer', () => {
  store('a').putContext('peer', 'ctx-a');
  store('b').putContext('peer', 'ctx-b');
  expect(store('a').contextFor('peer')).toBe('ctx-a');
  expect(store('b').contextFor('peer')).toBe('ctx-b');
});

it('quarantines malformed state instead of treating it as logged out', () => {
  writeFileSync(accountPath, '{bad');
  expect(() => store.loadAccount()).toThrow(/ILINK_STATE_CORRUPT/);
  expect(readdirSync(dirname(accountPath))).toContainEqual(expect.stringMatching(/account\.json\.corrupt/));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/wechat-ilink-store.test.ts`

Expected: FAIL because the store is missing.

- [ ] **Step 3: Implement four atomic account-scoped stores**

```ts
private writeJson(name: StateFile, value: unknown): void {
  const target = join(this.accountDir, name);
  const temp = join(this.accountDir, `.${name}.${randomUUID()}.tmp`);
  atomicWriteJson(temp, target, value, 0o600);
}
```

Persist `account.json`, `sync.json`, `context-tokens.json` and `inbound-dedupe.json`; prune dedupe entries older than 24 hours; never persist QR values, verification codes or an in-progress login generation.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/wechat-ilink-store.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(wechat): persist isolated iLink account state"`

### Task 4: Implement the cancellable login state machine

**Files:**
- Create: `src/channels/wechat/ilink/login-session.ts`
- Test: `tests/wechat-ilink-login.test.ts`

- [ ] **Step 1: Write failing lifecycle and stale-generation tests**

```ts
it('does not report connected before confirmed credentials are saved', async () => {
  api.statuses.push({ status: 'scaned' }, confirmedFixture());
  await login.start();
  expect(events.map((event) => event.phase)).toEqual(['qr_ready', 'scanned', 'connected']);
  expect(store.loadAccount()?.botToken).toBe('token');
});

it('ignores an old poll after refresh', async () => {
  const first = login.start();
  await login.refresh();
  api.resolveFirst(confirmedFixture());
  await first;
  expect(store.loadAccount()?.ilinkBotId).not.toBe('old-bot');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/wechat-ilink-login.test.ts`

Expected: FAIL because login session is missing.

- [ ] **Step 3: Implement state, QR refresh and verification submission**

```ts
private publish(generation: number, state: LoginState): void {
  if (generation !== this.generation || this.signal.aborted) return;
  this.state = state;
  this.onState(redactLoginState(state));
}

submitVerification(code: string): void {
  if (this.state.phase !== 'verification_required') throw new IlinkError('ILINK_NOT_WAITING_CODE');
  this.verification.resolve(z.string().regex(/^\d{4,8}$/).parse(code));
}
```

Refresh expired QR no more than configured count, pause for numeric verification, follow only validated redirects, and classify already-bound separately from success.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/wechat-ilink-login.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(wechat): manage iLink QR login sessions"`

### Task 5: Receive, deduplicate, reconnect and reply

**Files:**
- Create: `src/channels/wechat/ilink/driver.ts`
- Test: `tests/wechat-ilink-driver.test.ts`

- [ ] **Step 1: Write failing monitor and reply tests**

```ts
it('stores context before one-time dispatch and advances cursor', async () => {
  api.updates.push(updateBatch({ id: 'm1', peer: 'u1', context: 'ctx1', cursor: 'next' }));
  await driver.pollOnce();
  expect(store.contextFor('u1')).toBe('ctx1');
  expect(store.cursor()).toBe('next');
  expect(inbound).toHaveBeenCalledTimes(1);
  await driver.pollOnceWithSameBatch();
  expect(inbound).toHaveBeenCalledTimes(1);
});

it('refuses a reply without a peer context token', async () => {
  await expect(driver.sendText('unknown', 'hello')).rejects.toThrow(/ILINK_CONTEXT_REQUIRED/);
  expect(api.sent).toHaveLength(0);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/wechat-ilink-driver.test.ts`

Expected: FAIL because the driver is missing.

- [ ] **Step 3: Implement one monitor per account**

```ts
while (!signal.aborted) {
  try {
    const batch = await api.getUpdates(store.cursor(), signal);
    store.setCursor(batch.nextCursor);
    for (const message of batch.messages) await this.accept(message);
    backoff.reset();
  } catch (error) {
    if (isAuthFailure(error)) return this.failAuth();
    if (!isExpectedLongPollTimeout(error)) await backoff.wait(signal);
  }
}
```

Call notifyStart before polling, notifyStop best-effort on stop, use jittered 1-30 second backoff, map private/group session keys with account scope, and require `sendmessage` success before reporting sent.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/wechat-ilink-driver.test.ts`

Expected: PASS for restart, cursor resume, auth expiry, abort and generation races.

Commit: `git commit -m "feat(wechat): receive and reply through iLink"`

### Task 6: Integrate iLink with account runtime and legacy WeChat

**Files:**
- Modify: `src/control-plane/platform-adapters.ts`
- Modify: `src/channels/wechat.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/resolved.ts`
- Test: `tests/channels-wechat.test.ts`
- Create: `tests/wechat-ilink-integration.test.ts`

- [ ] **Step 1: Add failing two-account integration and no-fake-login tests**

```ts
it('runs two iLink accounts without sharing cursor or context', async () => {
  await Promise.all([supervisor.start('wechat-a'), supervisor.start('wechat-b')]);
  await ilinkServer.deliver('wechat-a', message('same-peer', 'one'));
  await ilinkServer.deliver('wechat-b', message('same-peer', 'two'));
  expect(sessions.keys()).toEqual(expect.arrayContaining([
    'wechat:wechat-a:user:same-peer', 'wechat:wechat-b:user:same-peer',
  ]));
});

it('legacy personal mode never writes a synthetic session', async () => {
  await expect(channel.start()).rejects.toThrow(/PUPPET/);
  expect(existsSync(sessionFile)).toBe(false);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/wechat-ilink-integration.test.ts tests/channels-wechat.test.ts`

Expected: FAIL on missing native mode and the current synthetic personal login.

- [ ] **Step 3: Wire the driver and remove fake success paths**

```ts
factory.register('wechat_ilink', ({ account, credentials, ingress, onState }) =>
  new IlinkBotDriver({ accountId: account.id, credentials, ingress, onState, apiFactory, stateRoot }),
);
```

Add strict `ilink_bot` compatibility config with `account_id`, keep `personal`, `wecom` and `official_account` meanings unchanged, and delete synthetic session/contact/send-success behavior.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/wechat-ilink-integration.test.ts tests/channels-wechat.test.ts tests/wechat-contacts.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(wechat): integrate iLink account runtimes"`

### Task 7: Add account-scoped QR and connection GUI

**Files:**
- Modify: `src/gui/shared.ts`
- Modify: `src/gui/service.ts`
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/app.js`
- Modify: `src/gui/renderer/styles.css`
- Test: `tests/renderer-ui.test.ts`
- Create: `tests/gui-wechat-ilink.test.ts`

- [ ] **Step 1: Write failing typed IPC and state-control tests**

```ts
it('requires account id for every QR operation', () => {
  expect(preloadSource).toContain("startWeChatLogin: (accountId)");
  expect(preloadSource).toContain("submitWeChatVerification: (accountId, code)");
});

it('only shows verification input in verification_required', () => {
  renderWeChatState({ phase: 'scanned' });
  expect(verificationInput.hidden).toBe(true);
  renderWeChatState({ phase: 'verification_required' });
  expect(verificationInput.hidden).toBe(false);
});
```

- [ ] **Step 2: Run and verify current global QR API fails**

Run: `npx vitest run tests/gui-wechat-ilink.test.ts tests/renderer-ui.test.ts`

Expected: FAIL because existing APIs are global and expose fake confirmation.

- [ ] **Step 3: Add typed account operations and stable UI states**

```ts
ipcMain.handle('gui:startWeChatLogin', (_event, accountId) =>
  invoke(() => service.startWeChatLogin(accountId)));
ipcMain.handle('gui:refreshWeChatQr', (_event, accountId) =>
  invoke(() => service.refreshWeChatQr(accountId)));
ipcMain.handle('gui:submitWeChatVerification', (_event, { accountId, code }) =>
  invoke(() => service.submitWeChatVerification(accountId, code)));
ipcMain.handle('gui:logoutWeChatAccount', (_event, accountId) =>
  invoke(() => service.logoutWeChatAccount(accountId)));
```

Render QR countdown, scanned/phone-confirm instructions, conditional verification, reconnect count, masked account and last message. Every action uses a per-account pending lock and updates only the account panel.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/gui-wechat-ilink.test.ts tests/renderer-ui.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(gui): connect WeChat iLink accounts by QR"`

### Task 8: Documentation and iLink verification

**Files:**
- Modify: `README.md`
- Modify: `config.example.toml`
- Modify: `dogfood-output/platform-control-audit/report.md`

- [ ] **Step 1: Update configuration truthfully**

Document that iLink connects a Tencent chatbot rather than a personal friend list, Puppet mode requires a supplier token, and enterprise/official modes remain separate. Do not include a real QR, token, user ID or message body.

- [ ] **Step 2: Run focused and repository verification**

Run: `npx vitest run tests/wechat-ilink-*.test.ts tests/channels-wechat.test.ts tests/gui-wechat-ilink.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck && npm run build`

Expected: every command exits 0.

- [ ] **Step 3: Perform real acceptance without storing secrets in artifacts**

Use a real QR to verify login, one inbound text, one reply, restart recovery, disconnect/reconnect, stop/start and logout. Record only redacted PASS/FAIL timestamps in the report.

- [ ] **Step 4: Commit**

Commit: `git commit -m "docs: document and verify WeChat iLink chatbot"`
