# Server Bot Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disconnected GUI bot JSON, global channels, and per-server webhook settings with one secure one-account-to-one-server runtime for Telegram, Feishu, and WeChat iLink.

**Architecture:** Add a SQLite metadata store, a permission-restricted credential store, an authorization/pairing service, a runtime supervisor, and an explicit control execution context enforced in the tool executor. Keep existing channel protocol code where possible, but construct one channel per account and derive all GUI status from the live supervisor.

**Tech Stack:** TypeScript 7, Node.js 20, better-sqlite3, Zod 4, Grammy, Electron IPC, Vitest

---

## File Map

- `src/control-plane/types.ts`: domain contracts, runtime states, control context and error codes.
- `src/control-plane/store.ts`: SQLite account, binding, operator, pairing and approval metadata.
- `src/control-plane/credential-store.ts`: atomic `0600` account credential files.
- `src/control-plane/authorization.ts`: pairing and role/profile authorization.
- `src/control-plane/runtime.ts`: account adapter contract and runtime supervisor.
- `src/control-plane/scoped-tools.ts`: final tool authorization and fixed server routing.
- `src/control-plane/migrate.ts`: idempotent import from GUI bot/server legacy data.
- `src/control-plane/index.ts`: public exports.
- `src/channels/types.ts`: carry trusted control context into task requests.
- `src/channels/telegram.ts`: accept direct account credentials and ingress authorization.
- `src/channels/feishu.ts`: accept account credentials and ingress authorization.
- `src/channels/manager.ts`: own a supervisor instead of one global account per platform.
- `src/tools/types.ts`, `src/tools/executor.ts`: final policy guard.
- `src/tools/builtin/remote-tools.ts`: force scoped server and hide other nodes.
- `src/gui/shared.ts`, `src/gui/service.ts`, `src/gui/main.ts`, `src/gui/renderer/preload.cjs`: typed account/binding/runtime IPC.
- `src/gui/renderer/index.html`, `src/gui/renderer/app.js`, `src/gui/renderer/styles.css`: one authoritative Bot workflow.
- `tests/control-plane-*.test.ts`, `tests/channels-*.test.ts`, `tests/tools.test.ts`, `tests/renderer-ui.test.ts`: coverage.

### Task 1: Define the control-plane contracts

**Files:**
- Create: `src/control-plane/types.ts`
- Create: `src/control-plane/index.ts`
- Test: `tests/control-plane-types.test.ts`

- [ ] **Step 1: Write failing schema and state tests**

```ts
import { describe, expect, it } from 'vitest';
import { botAccountInputSchema, canTransitionRuntime } from '../src/control-plane/index.js';

describe('control plane contracts', () => {
  it('rejects secrets in account metadata', () => {
    expect(botAccountInputSchema.safeParse({
      id: 'bot-a', platform: 'telegram', name: 'ops', enabled: false,
      credentialRef: 'bot-a', transport: 'polling', defaultAgentId: 'ops', token: 'secret',
    }).success).toBe(false);
  });

  it('does not allow saved config to jump to online', () => {
    expect(canTransitionRuntime('draft', 'online')).toBe(false);
    expect(canTransitionRuntime('starting', 'online')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm the module is missing**

Run: `npx vitest run tests/control-plane-types.test.ts`

Expected: FAIL because `src/control-plane/index.ts` does not exist.

- [ ] **Step 3: Implement strict Zod inputs and runtime contracts**

```ts
export const botPlatformSchema = z.enum(['wechat_ilink', 'telegram', 'feishu']);
export const runtimeStatusSchema = z.enum([
  'draft', 'validating', 'stopped', 'starting', 'online',
  'reconnecting', 'auth_required', 'error',
]);
export const botAccountInputSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  platform: botPlatformSchema,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  credentialRef: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  transport: z.enum(['ilink', 'polling', 'websocket', 'webhook']),
  defaultAgentId: z.string().trim().min(1),
});
export interface ControlExecutionContext {
  accountId: string;
  bindingId: string;
  serverId: string;
  operatorId: string;
  role: 'viewer' | 'operator' | 'admin';
  capabilityProfile: 'observe' | 'operate';
  requestId: string;
}
```

Export every public type and schema from `src/control-plane/index.ts` and implement a transition table that permits only documented runtime transitions.

- [ ] **Step 4: Run the test and commit**

Run: `npx vitest run tests/control-plane-types.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(control): define bot control contracts"`

### Task 2: Build the transactional metadata store

**Files:**
- Create: `src/control-plane/store.ts`
- Test: `tests/control-plane-store.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
it('enforces one account per server and one server per account', () => {
  const store = new ControlPlaneStore(tempDb());
  store.upsertAccount(account('a'));
  store.upsertAccount(account('b'));
  store.bind(binding('bind-a', 'local', 'a'));
  expect(() => store.bind(binding('bind-b', 'local', 'b'))).toThrow(/BINDING_CONFLICT/);
  expect(() => store.bind(binding('bind-c', 'remote-1', 'a'))).toThrow(/BINDING_CONFLICT/);
});

it('replaces a binding transactionally', () => {
  const store = seededStore();
  store.replaceBinding('local', binding('new', 'local', 'b'));
  expect(store.bindingForServer('local')?.botAccountId).toBe('b');
  expect(store.bindingForAccount('a')).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run tests/control-plane-store.test.ts`

Expected: FAIL because `ControlPlaneStore` is missing.

- [ ] **Step 3: Implement SQLite schema and explicit transactions**

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS bot_accounts (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
  enabled INTEGER NOT NULL, credential_ref TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL, default_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_bot_bindings (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL UNIQUE,
  bot_account_id TEXT NOT NULL UNIQUE REFERENCES bot_accounts(id) ON DELETE CASCADE,
  capability_profile TEXT NOT NULL, approval_policy TEXT NOT NULL,
  alert_policy_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_operators (
  id TEXT PRIMARY KEY, bot_account_id TEXT NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
  platform_user_id TEXT NOT NULL, display_name TEXT, role TEXT NOT NULL,
  paired_at TEXT NOT NULL, revoked_at TEXT,
  UNIQUE(bot_account_id, platform_user_id)
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY, bot_account_id TEXT NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, role TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES server_bot_bindings(id) ON DELETE CASCADE,
  operator_id TEXT NOT NULL REFERENCES bot_operators(id), request_id TEXT NOT NULL,
  command_kind TEXT NOT NULL, args_digest TEXT NOT NULL, risk TEXT NOT NULL,
  status TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT
);
```

Map SQLite constraint errors to a typed `BINDING_CONFLICT`, validate every write with the Task 1 schemas, expose `close()`, and use a single transaction for replacement.

- [ ] **Step 4: Verify persistence, reopening, conflicts and cascade deletion**

Run: `npx vitest run tests/control-plane-store.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(control): persist bot accounts and bindings"`

### Task 3: Store credentials without renderer readback

**Files:**
- Create: `src/control-plane/credential-store.ts`
- Test: `tests/control-plane-credentials.test.ts`

- [ ] **Step 1: Write failing atomic storage tests**

```ts
it('writes account credentials with restricted permissions', () => {
  const store = new BotCredentialStore(tempDir());
  store.write('bot-a', { token: 'secret' });
  expect(statSync(store.pathForTest('bot-a')).mode & 0o777).toBe(0o600);
  expect(store.summary('bot-a')).toEqual({ configured: true, fields: ['token'] });
});

it('rejects path traversal account ids', () => {
  expect(() => new BotCredentialStore(tempDir()).write('../x', { token: 'x' })).toThrow();
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run tests/control-plane-credentials.test.ts`

Expected: FAIL because the credential store is missing.

- [ ] **Step 3: Implement atomic `0600` JSON writes**

```ts
write(accountId: string, credentials: Record<string, string>): void {
  const id = accountIdSchema.parse(accountId);
  mkdirSync(this.root, { recursive: true, mode: 0o700 });
  chmodSync(this.root, 0o700);
  const target = join(this.root, `${id}.json`);
  const temp = join(this.root, `.${id}.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(credentials));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  chmodSync(target, 0o600);
}
```

`read()` remains backend-only. `summary()` returns field names and configured state but never values.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/control-plane-credentials.test.ts`

Expected: PASS on macOS/Linux; Windows asserts that no broad ACL fallback is introduced.

Commit: `git commit -m "feat(control): secure bot account credentials"`

### Task 4: Implement pairing and authorization

**Files:**
- Create: `src/control-plane/authorization.ts`
- Modify: `src/control-plane/store.ts`
- Test: `tests/control-plane-authorization.test.ts`

- [ ] **Step 1: Write failing deny-by-default and pairing tests**

```ts
it('denies every non-pair message before an operator exists', async () => {
  expect(authorizer.authorize(message('user-1', '/status'))).toEqual({ ok: false, code: 'NOT_PAIRED' });
});

it('consumes a local pairing code once', async () => {
  const code = authorizer.createPairingCode('bot-a', 'operator', now);
  expect(authorizer.pair('bot-a', 'user-1', 'Alice', code, now).ok).toBe(true);
  expect(authorizer.pair('bot-a', 'user-2', 'Bob', code, now).ok).toBe(false);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run tests/control-plane-authorization.test.ts`

Expected: FAIL because `BotAuthorizer` is missing.

- [ ] **Step 3: Implement hashed codes and role/profile intersection**

```ts
const ROLE_CAPABILITIES = {
  viewer: new Set(['status.read', 'usage.read', 'logs.read']),
  operator: new Set(['status.read', 'usage.read', 'logs.read', 'task.run', 'tool.mutate']),
  admin: new Set(['status.read', 'usage.read', 'logs.read', 'task.run', 'tool.mutate', 'change.approve']),
};

authorize(input: AuthorizeInput): AuthorizationResult {
  const operator = this.store.activeOperator(input.accountId, input.platformUserId);
  if (!operator) return { ok: false, code: 'NOT_PAIRED' };
  const allowed = ROLE_CAPABILITIES[operator.role].has(input.capability)
    && (input.profile === 'operate' || !input.capability.endsWith('.mutate'));
  return allowed ? { ok: true, operator } : { ok: false, code: 'POLICY_DENIED' };
}
```

Generate codes with `randomInt`, store only SHA-256 hashes, expire after ten minutes, and consume in one transaction.

- [ ] **Step 4: Verify expiry, replay, revocation and group sender identity**

Run: `npx vitest run tests/control-plane-authorization.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(control): pair and authorize bot operators"`

### Task 5: Enforce server scope at the tool executor

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/channels/types.ts`
- Modify: `src/channels/dispatcher.ts`
- Modify: `src/tools/types.ts`
- Modify: `src/tools/executor.ts`
- Modify: `src/tools/builtin/remote-tools.ts`
- Create: `src/control-plane/scoped-tools.ts`
- Test: `tests/control-plane-scoped-tools.test.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write failing cross-server tests**

```ts
it('forces remote_exec to the bound server', async () => {
  const result = await remoteExecTool.run(
    { command: 'hostname', server: 'other-server' },
    toolContext({ control: controlContext({ serverId: 'bound-server' }) }),
  );
  expect(remoteClient.lastServerId).toBe('bound-server');
  expect(result.isError).not.toBe(true);
});

it('rejects mutation for observe bindings before handler execution', async () => {
  const result = await executor.execute(call('remote_exec', { command: 'touch /tmp/x' }),
    toolContext({ control: controlContext({ capabilityProfile: 'observe' }) }));
  expect(result.isError).toBe(true);
  expect(remoteClient.calls).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests and confirm they expose the bypass**

Run: `npx vitest run tests/control-plane-scoped-tools.test.ts tests/tools.test.ts`

Expected: FAIL because the model-supplied `server` still controls routing.

- [ ] **Step 3: Carry trusted context and add the final guard**

```ts
export interface ToolContext {
  // existing fields...
  control?: ControlExecutionContext;
}

const decision = this.options.policy.authorizeTool(call.name, validated.args, ctx.control);
if (!decision.ok) {
  return this.finish(call, ctx, { content: decision.message, isError: true }, startedAt);
}
const guardedArgs = decision.serverId === undefined
  ? validated.args
  : { ...validated.args, server: decision.serverId };
const output = await this.runGuarded(module, guardedArgs, ctx, call);
```

Add `control?: ControlExecutionContext` to `InboundMessage`; ChannelDispatcher copies it into
`RunTaskRequest.executionContext.control`, and AgentOrchestrator copies it into ToolContext. Classify
built-in tools as read, mutate or dangerous. Hide `remote_list_servers` in control sessions and return only
the bound server from the scoped replacement.

- [ ] **Step 4: Verify direct, command and natural-language paths**

Run: `npx vitest run tests/control-plane-scoped-tools.test.ts tests/tools.test.ts tests/channels-dispatcher.test.ts`

Expected: PASS; no handler call occurs after denial.

Commit: `git commit -m "feat(control): enforce bound server at tool execution"`

### Task 6: Add runtime supervisor and true health states

**Files:**
- Create: `src/control-plane/runtime.ts`
- Modify: `src/channels/manager.ts`
- Test: `tests/control-plane-runtime.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('publishes online only after adapter start resolves', async () => {
  const start = deferred<void>();
  const supervisor = harness({ start: () => start.promise });
  const pending = supervisor.start('bot-a');
  expect(supervisor.snapshot('bot-a').status).toBe('starting');
  start.resolve();
  await pending;
  expect(supervisor.snapshot('bot-a').status).toBe('online');
});

it('runs accounts independently and stops idempotently', async () => {
  await Promise.all([supervisor.start('a'), supervisor.start('b')]);
  await Promise.all([supervisor.stop('a'), supervisor.stop('a')]);
  expect(supervisor.snapshot('b').status).toBe('online');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run tests/control-plane-runtime.test.ts`

Expected: FAIL because supervisor is missing.

- [ ] **Step 3: Implement adapter factory, generation guards and snapshots**

```ts
export interface BotRuntimeAdapter {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  validate(signal: AbortSignal): Promise<BotIdentity>;
}

async start(accountId: string): Promise<void> {
  return this.withAccountLock(accountId, async () => {
    const generation = this.nextGeneration(accountId);
    this.publish(accountId, 'starting');
    const adapter = this.factory.create(this.requireAccount(accountId));
    try {
      await adapter.start(this.signalFor(accountId));
      if (this.isCurrent(accountId, generation)) this.publish(accountId, 'online');
    } catch (error) {
      if (this.isCurrent(accountId, generation)) this.publishError(accountId, error);
      throw error;
    }
  });
}
```

ChannelManager starts enabled accounts via the supervisor and stops them in reverse order. It no longer creates one global Telegram/Feishu/WeChat control account.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/control-plane-runtime.test.ts tests/channels-core.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(control): supervise account channel runtimes"`

### Task 7: Adapt Telegram and Feishu accounts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/feishu.ts`
- Create: `src/control-plane/platform-adapters.ts`
- Test: `tests/control-plane-platforms.test.ts`
- Test: `tests/channels-telegram.test.ts`
- Test: `tests/feishu-channel.test.ts`

- [ ] **Step 1: Add failing account isolation and sender authorization tests**

```ts
it.each(['telegram', 'feishu'])('%s rejects unpaired senders before dispatch', async (platform) => {
  const adapter = platformHarness(platform, { authorized: false });
  await adapter.deliver(textEvent('unpaired', '/status'));
  expect(adapter.host.runTask).not.toHaveBeenCalled();
  expect(adapter.lastReply).toMatch(/配对/);
});

it('keeps two Telegram accounts isolated', async () => {
  await Promise.all([runtime.start('telegram-a'), runtime.start('telegram-b')]);
  expect(factory.tokensUsed).toEqual(['token-a', 'token-b']);
});
```

- [ ] **Step 2: Run tests and verify current global construction fails**

Run: `npx vitest run tests/control-plane-platforms.test.ts tests/channels-telegram.test.ts tests/feishu-channel.test.ts`

Expected: FAIL on direct per-account credentials and authorization middleware.

- [ ] **Step 3: Implement account adapters**

```ts
const ingress: AccountIngress = async ({ platformUserId, displayName, text, target }) => {
  if (text.startsWith('/pair ')) return this.pairAndReply(platformUserId, displayName, text, target);
  const authorized = this.authorizer.authorizeMessage(this.account.id, platformUserId);
  if (!authorized.ok) return target.send('未授权。请在 Hermes 本地生成一次性配对码。');
  return this.dispatcher.submit({
    channel: this.channelName,
    sessionKey: `${this.channelName}:${this.account.id}:user:${platformUserId}`,
    text,
    receivedAt: new Date().toISOString(),
    target,
    control: this.contextFactory.create(this.account.id, authorized.operator),
  });
};
```

Telegram accepts a direct token instead of an environment variable and calls `getMe` before online. Add `@larksuiteoapi/node-sdk`, use its WebSocket client by default, and retain the current webhook adapter only when transport is explicitly `webhook`.

- [ ] **Step 4: Verify both platforms and commit**

Run: `npx vitest run tests/control-plane-platforms.test.ts tests/channels-telegram.test.ts tests/feishu-channel.test.ts`

Expected: PASS with mocked SDK transports and no real network.

Commit: `git commit -m "feat(control): run authorized Telegram and Feishu accounts"`

### Task 8: Migrate legacy state without inventing health

**Files:**
- Create: `src/control-plane/migrate.ts`
- Modify: `src/remote/types.ts`
- Modify: `src/remote/storage.ts`
- Test: `tests/control-plane-migrate.test.ts`

- [ ] **Step 1: Write failing duplicate and invalid credential migration tests**

```ts
it('keeps the server-selected winner and leaves duplicates unbound', () => {
  const result = migrateLegacy(fixture('duplicate-bots'));
  expect(result.store.bindingForServer('local')?.botAccountId).toBe('server-selected');
  expect(result.store.bindingForAccount('duplicate')).toBeUndefined();
  expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_BINDING' }));
});

it('imports empty credentials as disabled drafts', () => {
  expect(migrateLegacy(fixture('empty-token')).accounts[0]).toMatchObject({ enabled: false });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/control-plane-migrate.test.ts`

Expected: FAIL because the migrator does not exist.

- [ ] **Step 3: Implement versioned idempotent migration**

```ts
export function migrateLegacy(input: LegacySources, deps: MigrationDeps): MigrationReport {
  if (deps.store.schemaVersion() >= TARGET_VERSION) return { migrated: false, warnings: [] };
  return deps.store.transaction(() => {
    const normalized = normalizeLegacyAccounts(input);
    for (const account of normalized.accounts) deps.store.upsertAccount(account);
    for (const binding of chooseBindings(normalized, input.servers)) deps.store.bind(binding);
    deps.store.setSchemaVersion(TARGET_VERSION);
    return { migrated: true, warnings: normalized.warnings };
  });
}
```

Keep legacy files intact, remove writes to `boundBotId` and `botConfig`, and make RemoteServerStore return binding data only through the control-plane facade.

- [ ] **Step 4: Verify migration and commit**

Run: `npx vitest run tests/control-plane-migrate.test.ts tests/remote.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(control): migrate legacy bot bindings"`

### Task 9: Replace GUI bot and node settings APIs

**Files:**
- Modify: `src/gui/shared.ts`
- Modify: `src/gui/service.ts`
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/app.js`
- Modify: `src/gui/renderer/styles.css`
- Test: `tests/renderer-ui.test.ts`
- Create: `tests/gui-control-plane.test.ts`

- [ ] **Step 1: Write failing service and renderer contracts**

```ts
it('never returns account secrets to the renderer', async () => {
  const accounts = await service.listBotAccounts();
  expect(JSON.stringify(accounts)).not.toContain('token-a');
  expect(accounts[0]?.credentials).toEqual({ configured: true, fields: ['token'] });
});

it('renderer does not use localStorage nodeBotConfigs', () => {
  expect(rendererSource).not.toContain("localStorage.getItem('nodeBotConfigs')");
  expect(rendererSource).toContain('window.hap.getServerBotBinding');
});
```

- [ ] **Step 2: Run and confirm existing JSON/localStorage behavior fails**

Run: `npx vitest run tests/gui-control-plane.test.ts tests/renderer-ui.test.ts`

Expected: FAIL on secret readback, localStorage and fake running status.

- [ ] **Step 3: Add typed IPC and one setup workflow**

```ts
ipcMain.handle('gui:listBotAccounts', () => invoke(() => service.listBotAccounts()));
ipcMain.handle('gui:saveBotAccount', (_event, input) => invoke(() => service.saveBotAccount(input)));
ipcMain.handle('gui:validateBotAccount', (_event, id) => invoke(() => service.validateBotAccount(id)));
ipcMain.handle('gui:bindBotAccount', (_event, input) => invoke(() => service.bindBotAccount(input)));
ipcMain.handle('gui:createPairingCode', (_event, input) => invoke(() => service.createPairingCode(input)));
ipcMain.handle('gui:startBotAccount', (_event, id) => invoke(() => service.startBotAccount(id)));
ipcMain.handle('gui:stopBotAccount', (_event, id) => invoke(() => service.stopBotAccount(id)));
```

Remove bot credentials from `GuiBotInstance`, render supervisor snapshots, disable repeated clicks while pending, and make the panorama Bot button open the same binding editor as Settings. Do not add nested cards or inline white panels.

- [ ] **Step 4: Verify UI contracts and commit**

Run: `npx vitest run tests/gui-control-plane.test.ts tests/renderer-ui.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(gui): manage server bot control bindings"`

### Task 10: Integrate alerts, approvals and full control-plane verification

**Files:**
- Modify: `src/control-plane/store.ts`
- Modify: `src/control-plane/authorization.ts`
- Modify: `src/gui/service.ts`
- Modify: `src/channels/dispatcher.ts`
- Modify: `src/remote/types.ts`
- Test: `tests/control-plane-approvals.test.ts`
- Test: `tests/channels-dispatcher.test.ts`
- Modify: `dogfood-output/platform-control-audit/report.md`

- [ ] **Step 1: Add failing approval and single alert route tests**

```ts
it('requires local approval for dangerous tools', async () => {
  const result = await policy.authorizeTool('remote_exec', { command: 'rm -rf /srv/app' }, controlContext());
  expect(result).toMatchObject({ ok: false, code: 'LOCAL_APPROVAL_REQUIRED' });
});

it('routes a server alert through its one binding', async () => {
  await alerts.send('remote-1', highCpuAlert());
  expect(runtime.sent).toEqual([{ accountId: 'bot-a', targetId: 'paired-admin', kind: 'high_cpu' }]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run tests/control-plane-approvals.test.ts tests/channels-dispatcher.test.ts`

Expected: FAIL because dispatcher commands and alert webhooks bypass the policy.

- [ ] **Step 3: Route commands, approvals and alerts through shared services**

```ts
const approval = policy.requireApproval(command, message.control);
if (approval.required) {
  const request = approvals.create({
    context: message.control,
    commandKind: command.kind,
    argsDigest: digestArgs(command),
    risk: approval.risk,
  });
  await reply(message.target, `操作需要${approval.local ? '本地' : '二次'}批准：${request.id}`);
  return;
}
```

Remove direct webhook alert sending and resolve the account plus authorized target from the binding. Audit only IDs, digests, result, duration and token totals.

- [ ] **Step 4: Run control-plane verification**

Run: `npx vitest run tests/control-plane-*.test.ts tests/channels-telegram.test.ts tests/feishu-channel.test.ts tests/channels-dispatcher.test.ts tests/remote.test.ts tests/tools.test.ts tests/renderer-ui.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the integrated control plane**

Commit: `git commit -m "feat(control): approve operations and route server alerts"`
