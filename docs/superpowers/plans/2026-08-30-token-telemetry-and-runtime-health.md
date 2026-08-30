# Token Telemetry and Runtime Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show authoritative live task, session, agent, server and global token usage, and replace static green model badges with recent verified provider health.

**Architecture:** Extend usage rows with task and execution dimensions, persist provider-reported deltas idempotently, and publish throttled main-process snapshots to Electron. Use the same query service for GUI, channel and HTTP usage commands; keep provider health on a separate single-flight event path.

**Tech Stack:** TypeScript 7, better-sqlite3, Electron IPC, Vitest, existing provider adapters

---

## File Map

- `src/telemetry/types.ts`: event, filter, bucket, snapshot and health contracts.
- `src/telemetry/service.ts`: validation, event IDs, active accumulators and subscriptions.
- `src/telemetry/query.ts`: bounded cross-agent usage aggregation.
- `src/telemetry/provider-health.ts`: checked/ready/degraded/unavailable state.
- `src/telemetry/index.ts`: exports.
- `src/agent/types.ts`, `src/agent/loop.ts`, `src/agent/orchestrator.ts`, `src/agent/subagent.ts`: dimensions and all usage sources.
- `src/storage/session-store.ts`: idempotent usage event migration and queries.
- `src/channels/types.ts`, `src/channels/manager.ts`, `src/channels/dispatcher.ts`, `src/channels/http.ts`: shared usage query.
- `src/gui/shared.ts`, `src/gui/service.ts`, `src/gui/main.ts`, `src/gui/renderer/preload.cjs`: snapshot/query/health IPC.
- `src/gui/renderer/index.html`, `src/gui/renderer/app.js`, `src/gui/renderer/styles.css`: fixed-size telemetry surfaces.
- `tests/telemetry-*.test.ts`, `tests/storage.test.ts`, `tests/orchestrator.test.ts`, `tests/renderer-ui.test.ts`: coverage.

### Task 1: Define execution and telemetry contracts

**Files:**
- Create: `src/telemetry/types.ts`
- Create: `src/telemetry/index.ts`
- Modify: `src/agent/types.ts`
- Test: `tests/telemetry-types.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
it('requires non-negative safe integer token counts', () => {
  expect(usageTelemetryEventSchema.safeParse(event({ totalTokens: -1 })).success).toBe(false);
  expect(usageTelemetryEventSchema.safeParse(event({ totalTokens: Number.MAX_VALUE })).success).toBe(false);
});

it('requires explicit server attribution', () => {
  expect(usageTelemetryEventSchema.safeParse(event({ serverId: undefined })).success).toBe(false);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/telemetry-types.test.ts`

Expected: FAIL because telemetry contracts are missing.

- [ ] **Step 3: Add strict event and request context types**

```ts
export interface TaskExecutionContext {
  serverId: string;
  botAccountId?: string;
  parentTaskId?: string;
  control?: ControlExecutionContext;
}

export const usageTelemetryEventSchema = z.strictObject({
  eventId: z.string().uuid(), sequence: z.number().int().nonnegative(), at: z.string().datetime(),
  taskId: z.string().min(1), parentTaskId: z.string().min(1).optional(),
  sessionKey: z.string().min(1), agentId: z.string().min(1), serverId: z.string().min(1),
  botAccountId: z.string().min(1).optional(), providerId: z.string().min(1), model: z.string().min(1),
  source: z.enum(['model_turn', 'compaction', 'subagent', 'reconciliation']),
  promptTokens: z.number().int().nonnegative().safe(),
  completionTokens: z.number().int().nonnegative().safe(),
  totalTokens: z.number().int().nonnegative().safe(),
}).refine((value) => value.totalTokens >= value.promptTokens + value.completionTokens);
```

Add `executionContext?: TaskExecutionContext` to RunTaskRequest and LoopRequest. Default only at trusted entry points, never from prompt text.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/telemetry-types.test.ts tests/agent.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(telemetry): define usage execution dimensions"`

### Task 2: Migrate usage persistence to idempotent events

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/storage/session-store.ts`
- Test: `tests/storage.test.ts`
- Create: `tests/telemetry-storage.test.ts`

- [ ] **Step 1: Write failing migration and idempotency tests**

```ts
it('does not double count the same usage event', () => {
  const store = sqliteStore();
  store.recordUsageEvent(usageEvent({ eventId: FIXED_ID, totalTokens: 10 }));
  store.recordUsageEvent(usageEvent({ eventId: FIXED_ID, totalTokens: 10 }));
  expect(store.queryUsage({ since: DAY_START }).totals.totalTokens).toBe(10);
});

it('keeps legacy rows global but not local-server attributed', () => {
  const store = openLegacyUsageDb();
  expect(store.queryUsage({ since: DAY_START }).totals.totalTokens).toBe(20);
  expect(store.queryUsage({ since: DAY_START, serverId: 'local' }).totals.totalTokens).toBe(0);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/telemetry-storage.test.ts tests/storage.test.ts`

Expected: FAIL because old usage rows have no event/task/server columns.

- [ ] **Step 3: Add idempotent columns, indexes and bounded query**

```sql
ALTER TABLE usage ADD COLUMN event_id TEXT;
ALTER TABLE usage ADD COLUMN task_id TEXT;
ALTER TABLE usage ADD COLUMN session_key TEXT;
ALTER TABLE usage ADD COLUMN server_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE usage ADD COLUMN bot_account_id TEXT;
ALTER TABLE usage ADD COLUMN source TEXT NOT NULL DEFAULT 'reconciliation';
ALTER TABLE usage ADD COLUMN parent_task_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event ON usage(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_server_at ON usage(server_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_session_at ON usage(session_key, at);
CREATE INDEX IF NOT EXISTS idx_usage_task ON usage(task_id);
```

Because SQLite lacks portable `ADD COLUMN IF NOT EXISTS`, inspect `PRAGMA table_info(usage)` before each ALTER. Insert with `ON CONFLICT(event_id) DO NOTHING`; require `since` and cap ranges at 366 days.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/telemetry-storage.test.ts tests/storage.test.ts`

Expected: PASS for old and new database fixtures.

Commit: `git commit -m "feat(telemetry): persist dimensional usage events"`

### Task 3: Implement telemetry service and snapshots

**Files:**
- Create: `src/telemetry/service.ts`
- Create: `src/telemetry/query.ts`
- Test: `tests/telemetry-service.test.ts`

- [ ] **Step 1: Write failing event, snapshot and failure tests**

```ts
it('persists before publishing and updates active totals once', () => {
  telemetry.record(delta({ eventId: ID, taskId: 't1', totalTokens: 7 }));
  telemetry.record(delta({ eventId: ID, taskId: 't1', totalTokens: 7 }));
  expect(order).toEqual(['persist', 'publish']);
  expect(telemetry.snapshot().activeTasks[0]?.totalTokens).toBe(7);
});

it('reports degraded telemetry instead of a false zero', () => {
  store.recordUsageEvent.mockImplementation(() => { throw new Error('disk full'); });
  expect(() => telemetry.record(delta())).not.toThrow();
  expect(telemetry.snapshot().status).toBe('degraded');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/telemetry-service.test.ts`

Expected: FAIL because service is missing.

- [ ] **Step 3: Implement active accumulators and incremental today buckets**

```ts
record(input: UsageTelemetryInput): void {
  const event = this.withIdentity(input);
  try {
    if (!this.store.recordUsageEvent(event)) return;
    this.active.add(event);
    this.today.add(event);
    this.sequence = event.sequence;
    this.emitter.emit('changed', this.sequence);
  } catch (error) {
    this.status = { kind: 'degraded', message: safeTelemetryError(error) };
    this.emitter.emit('changed', this.sequence);
  }
}
```

Initialize today buckets once, expose immutable snapshots, remove active tasks on finish, and perform low-frequency persisted reconciliation without scanning on every event.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/telemetry-service.test.ts tests/telemetry-storage.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(telemetry): publish live usage snapshots"`

### Task 4: Capture every model usage source

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/compactor.ts`
- Modify: `src/agent/orchestrator.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/tools/types.ts`
- Test: `tests/orchestrator.test.ts`
- Create: `tests/telemetry-orchestrator.test.ts`

- [ ] **Step 1: Write failing multi-source and failure tests**

```ts
it('records turns, compaction and subagent usage exactly once', async () => {
  await orchestrator.runTask(requestWithCompactionAndSubagent());
  expect(telemetry.events.map((event) => event.source)).toEqual([
    'model_turn', 'compaction', 'subagent', 'model_turn',
  ]);
  expect(orchestrator.store('coder').task(taskId)?.usage.totalTokens)
    .toBe(sum(telemetry.events, 'totalTokens'));
});

it('keeps reported usage when the task later fails', async () => {
  await orchestrator.runTask(requestThatFailsAfterUsage());
  expect(query.task(taskId).totalTokens).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/telemetry-orchestrator.test.ts tests/orchestrator.test.ts`

Expected: FAIL because compaction is not emitted and persistence waits for task success.

- [ ] **Step 3: Record deltas at their source and derive final TaskRow totals**

```ts
const recordUsage = (usage: TokenUsage, source: UsageSource, providerId: string, model: string): void => {
  if (usage.totalTokens === 0) return;
  telemetry.record({ taskId, sessionKey, agentId: agent.id, executionContext,
    providerId, model, source, usage });
  request.onEvent?.({ type: 'usage', usage, source });
};
```

Pass execution context unchanged to subagents, set parentTaskId, remove the old end-only `recordUsage` call, and write TaskRow totals from `telemetry.taskTotals(taskId)`. Use a positive reconciliation only for legacy final-only providers.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/telemetry-orchestrator.test.ts tests/orchestrator.test.ts tests/agent.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(telemetry): capture all agent token usage"`

### Task 5: Unify usage queries and local `/usage`

**Files:**
- Modify: `src/channels/types.ts`
- Modify: `src/channels/manager.ts`
- Modify: `src/channels/dispatcher.ts`
- Modify: `src/channels/http.ts`
- Modify: `src/gui/service.ts`
- Test: `tests/channels-dispatcher.test.ts`
- Test: `tests/channels-http.test.ts`
- Create: `tests/gui-usage-command.test.ts`

- [ ] **Step 1: Write failing shared-query tests**

```ts
it('GUI /usage does not create an agent task', async () => {
  const reply = await service.chat({ text: '/usage 7', sessionKey: 'gui:s1' });
  expect(orchestrator.runTask).not.toHaveBeenCalled();
  expect(reply.kind).toBe('usage');
  expect(reply.usage.totals.totalTokens).toBe(123);
});

it('channel and HTTP usage share the same filter semantics', async () => {
  expect(channelUsage(7)).toEqual(httpUsage(7));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/gui-usage-command.test.ts tests/channels-dispatcher.test.ts tests/channels-http.test.ts`

Expected: FAIL because GUI forwards `/usage` to the model.

- [ ] **Step 3: Route every surface to UsageQueryService**

```ts
const command = parseCommand(input.text);
if (command.kind === 'usage') {
  return { kind: 'usage', usage: this.usageQuery.query({
    since: daysAgo(command.days), sessionKey: input.sessionKey,
  }) };
}
return this.orchestrator.runTask(toRunTaskRequest(input));
```

Reject invalid days locally, keep HTTP ranges bounded, and render channel text from structured buckets rather than maintaining a second aggregate implementation.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/gui-usage-command.test.ts tests/channels-dispatcher.test.ts tests/channels-http.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(telemetry): unify usage queries across channels"`

### Task 6: Add throttled Electron usage IPC

**Files:**
- Modify: `src/gui/shared.ts`
- Modify: `src/gui/service.ts`
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Create: `tests/gui-usage-ipc.test.ts`

- [ ] **Step 1: Write failing subscription and cleanup tests**

```ts
it('coalesces usage changes to at most one notification per 250ms', async () => {
  for (let i = 0; i < 20; i += 1) telemetry.emit(i);
  await vi.advanceTimersByTimeAsync(249);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(1);
});

it('preload listener returns an unsubscribe function', () => {
  const off = bridge.onUsageChanged(callback);
  off();
  expect(removeListener).toHaveBeenCalledWith('gui:usageChanged', expect.any(Function));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/gui-usage-ipc.test.ts`

Expected: FAIL because no subscription exists.

- [ ] **Step 3: Implement typed snapshot/query and a coalesced notifier**

```ts
ipcMain.handle('gui:getUsageSnapshot', () => invoke(() => service.getUsageSnapshot()));
ipcMain.handle('gui:queryUsage', (_event, filter) => invoke(() => service.queryUsage(filter)));

const unsubscribe = telemetry.onChanged(() => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('gui:usageChanged');
  }, 250);
});
```

Remove listeners on app shutdown and expose preload `onUsageChanged(callback)` with exact listener removal.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/gui-usage-ipc.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(gui): stream throttled usage updates"`

### Task 7: Render five-level Token telemetry without layout churn

**Files:**
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/app.js`
- Modify: `src/gui/renderer/styles.css`
- Modify: `tests/renderer-ui.test.ts`
- Create: `tests/renderer-usage.test.ts`

- [ ] **Step 1: Write failing renderer contracts**

```ts
it('renders task, session, agent, server and global usage surfaces', () => {
  for (const id of ['taskTokenUsage', 'sessionTokenUsage', 'agentTokenUsage',
    'serverTokenUsage', 'globalTokenUsage']) expect(html).toContain(`id="${id}"`);
});

it('usage events do not invoke host-system refresh', () => {
  expect(usageHandlerSource).not.toContain('refreshHostView');
  expect(usageHandlerSource).not.toContain('innerHTML = renderPanorama');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/renderer-usage.test.ts tests/renderer-ui.test.ts`

Expected: FAIL because telemetry elements do not exist.

- [ ] **Step 3: Add fixed-size counters and focused updates**

```js
function applyUsageSnapshot(snapshot) {
  updateUsageCounter('globalTokenUsage', snapshot.globalToday);
  updateUsageCounter('serverTokenUsage', findServerUsage(snapshot, activePanoramaTarget));
  updateUsageCounter('agentTokenUsage', findAgentUsage(snapshot, currentAgentId));
  updateUsageCounter('sessionTokenUsage', findSessionUsage(snapshot, currentSessionKey));
  updateUsageCounter('taskTokenUsage', findTaskUsage(snapshot, currentTaskId));
}
```

Use tabular numbers, stable min widths, compact `K/M` display with exact title text, explicit loading/empty/degraded states, and a paginated 1/7/30-day detail view. Reuse CSS variables and remove inline white backgrounds touched by this workflow.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/renderer-usage.test.ts tests/renderer-ui.test.ts`

Expected: PASS.

Commit: `git commit -m "feat(gui): display live token telemetry"`

### Task 8: Replace static readiness with provider health

**Files:**
- Create: `src/telemetry/provider-health.ts`
- Modify: `src/gui/service.ts`
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Modify: `src/gui/renderer/app.js`
- Test: `tests/providers.test.ts`
- Create: `tests/provider-health.test.ts`
- Modify: `tests/renderer-ui.test.ts`

- [ ] **Step 1: Write failing health state tests**

```ts
it('never marks configured-only models ready', () => {
  expect(health.snapshot('ollama')).toMatchObject({ status: 'unchecked' });
});

it('uses one probe within the 60-second TTL and downgrades on request failure', async () => {
  await Promise.all([health.refresh('ollama'), health.refresh('ollama')]);
  expect(probe).toHaveBeenCalledTimes(1);
  health.observeRequestFailure('ollama', new Error('ECONNREFUSED'));
  expect(health.snapshot('ollama').status).toBe('unavailable');
});
```

- [ ] **Step 2: Run and verify current static badge fails**

Run: `npx vitest run tests/provider-health.test.ts tests/providers.test.ts tests/renderer-ui.test.ts`

Expected: FAIL because configuration is rendered green without a probe.

- [ ] **Step 3: Implement single-flight TTL health and GUI state mapping**

```ts
async refresh(providerId: string): Promise<ProviderHealthSnapshot> {
  const cached = this.cache.get(providerId);
  if (cached && Date.now() - cached.checkedAt < 60_000) return cached;
  const running = this.inflight.get(providerId);
  if (running) return running;
  const probe = this.runProbe(providerId).finally(() => this.inflight.delete(providerId));
  this.inflight.set(providerId, probe);
  return probe;
}
```

Map success to ready, auth/network to unavailable, rate-limit/5xx to degraded and no check to gray unchecked. A successful real model call refreshes readiness; a real failure immediately downgrades it.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/provider-health.test.ts tests/providers.test.ts tests/renderer-ui.test.ts`

Expected: PASS.

Commit: `git commit -m "fix(gui): derive model readiness from live health"`

### Task 9: Full telemetry and responsive verification

**Files:**
- Modify: `dogfood-output/platform-control-audit/report.md`
- Create: `dogfood-output/platform-control-audit/screenshots/fixed-token-*.png`

- [ ] **Step 1: Run focused tests**

Run: `npx vitest run tests/telemetry-*.test.ts tests/gui-usage-*.test.ts tests/renderer-usage.test.ts tests/provider-health.test.ts`

Expected: PASS.

- [ ] **Step 2: Run repository gates**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command exits 0; if lint has an established repository-wide parser failure, record it separately and run ESLint on all touched files with zero new errors.

- [ ] **Step 3: Replay usage and health dogfood scenarios**

Launch Electron with CDP. At desktop, 900x700 and 720x600, run a multi-iteration task, switch sessions/agents/servers, submit `/usage 7`, select an unavailable local model, and confirm no white page, overlap, duplicate listener, hardware-refresh loop or false green state.

- [ ] **Step 4: Update report and commit**

Record per-issue PASS evidence and exact command results without prompts, replies or credentials.

Commit: `git commit -m "test: verify token telemetry and runtime health"`
