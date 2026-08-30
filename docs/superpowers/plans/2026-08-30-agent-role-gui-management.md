# Agent Role GUI Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete create and safe-delete workflows to the Electron agent-role management GUI.

**Architecture:** Keep the existing shared agent form and switch it explicitly between create and edit modes. Route deletion through a new preload/main/service method and delegate persistence plus reference cleanup to `ConfigWriter.removeAgent()`, keeping configuration ownership out of the renderer.

**Tech Stack:** Electron 37, vanilla HTML/CSS/JavaScript renderer, TypeScript service and IPC layers, Vitest source-contract and integration tests.

---

## File Map

- `src/gui/renderer/index.html`: add the page-level create action and expose the role ID in the shared create/edit dialog.
- `src/gui/renderer/app.js`: control create/edit form modes, submit mode-aware input, render delete actions, and handle delete confirmation.
- `src/gui/renderer/preload.cjs`: expose the narrow `removeAgent(id)` renderer bridge.
- `src/gui/main.ts`: register `gui:removeAgent` and delegate to `GuiService`.
- `src/gui/service.ts`: validate create-vs-update semantics and delegate agent removal to `ConfigWriter`.
- `tests/renderer-ui.test.ts`: protect the renderer and IPC source contracts without introducing a browser test framework.
- `tests/gui-service.test.ts`: exercise create conflict handling and persisted removal against a temporary TOML configuration.

### Task 1: Shared Create And Edit Dialog

**Files:**
- Modify: `tests/renderer-ui.test.ts`
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/app.js`

- [ ] **Step 1: Write the failing renderer contract test**

Append this test to `tests/renderer-ui.test.ts`:

```ts
it('supports distinct create and edit modes for agent roles', () => {
  const view = section(html, '<section id="agents"', '<!-- 独立视图: 远程服务器');
  const dialog = section(html, '<dialog id="agentModal"', '<!-- 弹窗 3: 项目');
  const controller = section(app, '// 5.5 智能体角色管理', '// 6. 模型目录管理');

  expect(view).toContain('id="addAgentBtn"');
  expect(dialog).toContain('id="agentInputId"');
  expect(dialog).toContain('id="agentSubmitBtn"');
  expect(controller).toContain("let agentFormMode = 'edit'");
  expect(controller).toContain("$('addAgentBtn')?.addEventListener");
  expect(controller).toContain("agentIdInput.readOnly = false");
  expect(controller).toContain("agentIdInput.readOnly = true");
  expect(controller).toContain("create: agentFormMode === 'create'");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/renderer-ui.test.ts`

Expected: FAIL because `addAgentBtn`, `agentSubmitBtn`, and the mode controller do not exist.

- [ ] **Step 3: Add the create action and editable ID field**

In the `agents` page header in `src/gui/renderer/index.html`, add:

```html
<div class="page-header-actions">
  <button type="button" class="btn primary" id="addAgentBtn">
    <span aria-hidden="true">＋</span>
    新增角色
  </button>
</div>
```

Replace the hidden `agentInputId` with the first full-width form group:

```html
<div class="form-group full-width" id="agentIdFormGroup">
  <label for="agentInputId">角色 ID *</label>
  <input id="agentInputId" name="id" autocomplete="off" placeholder="如：data-analyst" required />
  <small class="form-hint">创建后不可修改，用于对话、通道和自动化任务引用。</small>
</div>
```

Give the existing submit button an ID and neutral initial label:

```html
<button type="submit" class="btn primary" id="agentSubmitBtn">保存配置</button>
```

- [ ] **Step 4: Implement mode-aware dialog setup**

At the start of the agent controller in `src/gui/renderer/app.js`, add reusable model-option and dialog helpers:

```js
let agentFormMode = 'edit';

function populateAgentModelOptions(selectedModel = '') {
  const modelSelect = $('agentInputModel');
  if (!modelSelect) return;
  modelSelect.innerHTML = (state.models || []).map((model) => `
    <option value="${esc(model.alias)}" ${model.alias === selectedModel ? 'selected' : ''}>
      ${esc(model.alias)} (${esc(model.providerId || model.provider)})
    </option>
  `).join('');
}

function openCreateAgentDialog() {
  agentFormMode = 'create';
  $('agentForm').reset();
  const agentIdInput = $('agentInputId');
  agentIdInput.readOnly = false;
  agentIdInput.value = '';
  $('agentModalEmoji').textContent = '';
  $('agentModalTitle').textContent = '新增智能体角色';
  $('agentSubmitBtn').textContent = '创建角色';
  $('agentInputToolTier').value = 'standard';
  populateAgentModelOptions(state.models?.[0]?.alias || '');
  $('agentModal').showModal();
  agentIdInput.focus();
}

$('addAgentBtn')?.addEventListener('click', openCreateAgentDialog);
```

Update `window.openAgentDialog` so edit mode locks the ID and uses the shared model helper:

```js
window.openAgentDialog = (agentId) => {
  const agent = (state.agents || []).find((item) => item.id === agentId);
  if (!agent) return;

  agentFormMode = 'edit';
  $('agentForm').reset();
  const agentIdInput = $('agentInputId');
  agentIdInput.value = agent.id;
  agentIdInput.readOnly = true;
  $('agentInputDisplayName').value = agent.displayName || agent.name || agent.id;
  $('agentInputEmoji').value = agent.emoji || '';
  $('agentModalEmoji').textContent = agent.emoji || '';
  $('agentModalTitle').textContent = `配置智能体: ${agent.id}`;
  $('agentSubmitBtn').textContent = '保存配置';
  $('agentInputWorkspace').value = agent.workspace || '';
  $('agentInputDescription').value = agent.description || '';
  $('agentInputToolTier').value = agent.toolTier || 'coding';
  populateAgentModelOptions(agent.model || '');
  $('agentModal').showModal();
};
```

In the form submit handler, reject a duplicate create locally and send mode intent to the service:

```js
const isCreate = agentFormMode === 'create';
if (isCreate && (state.agents || []).some((agent) => agent.id === id)) {
  showToast(`智能体 ID [${id}] 已存在`, 'error');
  return;
}

await window.hap.upsertAgent({
  id,
  create: isCreate,
  displayName,
  emoji,
  model,
  workspace,
  description,
  toolTier,
});
$('agentModal').close();
showToast(`智能体 [${id}] ${isCreate ? '已创建' : '配置已保存'}`, 'success');
await refresh();
```

- [ ] **Step 5: Run the renderer test and verify it passes**

Run: `npx vitest run tests/renderer-ui.test.ts`

Expected: PASS for the new create/edit contract and all existing renderer contracts.

- [ ] **Step 6: Commit the create/edit workflow**

```bash
git add tests/renderer-ui.test.ts src/gui/renderer/index.html src/gui/renderer/app.js
git commit -m "feat(gui): add agent role creation"
```

### Task 2: Service Validation And Removal

**Files:**
- Create: `tests/gui-service.test.ts`
- Modify: `src/gui/service.ts`

- [ ] **Step 1: Write failing service integration tests**

Create `tests/gui-service.test.ts` with an Electron mock and a temporary configuration:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { loadConfig } from '../src/config/index.js';
import { GuiService } from '../src/gui/service.js';

const initialConfig = [
  'default_agent = "helper"',
  '',
  '[agents.entries.helper]',
  'description = "Temporary helper"',
  '',
  '[agents.entries.coder]',
  'description = "Coder"',
  '',
  '[agents.entries.coder.subagents]',
  'allow = ["helper"]',
  '',
].join('\n');

describe('GuiService agent role management', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hap-gui-agent-'));
    configPath = join(testDir, 'config.toml');
    writeFileSync(configPath, initialConfig, 'utf8');
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('rejects a duplicate id when creating but still allows editing', () => {
    const service = new GuiService(configPath);
    expect(() => service.upsertAgent({ id: 'helper', create: true }))
      .toThrow('智能体 ID "helper" 已存在');
    expect(() => service.upsertAgent({ id: 'helper', description: 'Updated' }))
      .not.toThrow();
  });

  it('creates a role through the existing upsert boundary', () => {
    const service = new GuiService(configPath);
    service.upsertAgent({ id: 'data-analyst', create: true, description: 'Analyze data' });
    expect(loadConfig({ path: configPath }).config.agents?.entries?.['data-analyst']?.description)
      .toBe('Analyze data');
  });

  it('removes a role and lets ConfigWriter clear its references', () => {
    const service = new GuiService(configPath);
    service.removeAgent('helper');
    const config = loadConfig({ path: configPath }).config;
    expect(config.agents?.entries?.helper).toBeUndefined();
    expect(config.agents?.entries?.coder?.subagents?.allow).toEqual([]);
    expect(config.default_agent).toBeUndefined();
  });

  it('reports an unknown role without changing the config', () => {
    const service = new GuiService(configPath);
    expect(() => service.removeAgent('missing')).toThrow('没有智能体 "missing"');
    expect(loadConfig({ path: configPath }).config.agents?.entries?.helper).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the service test and verify it fails**

Run: `npx vitest run tests/gui-service.test.ts`

Expected: FAIL because `GuiService` has no injectable constructor, no create-conflict guard, and no `removeAgent()` method.

- [ ] **Step 3: Add an injectable config path and authoritative service behavior**

Replace the inline `configPath` property in `GuiService` with:

```ts
export class GuiService {
  private readonly logs: GuiLogEntry[] = [];

  constructor(
    private readonly configPath = resolveConfigPath(undefined, process.env),
  ) {}
```

Extend the `upsertAgent` input and add the conflict guard before constructing `ConfigWriter`:

```ts
upsertAgent(input: {
  id: string;
  create?: boolean;
  displayName?: string;
  emoji?: string;
  model?: string;
  workspace?: string;
  description?: string;
  toolTier?: 'minimal' | 'standard' | 'coding' | 'research' | 'full';
}): object {
  const id = input.id.trim();
  if (!id) throw new Error('智能体 ID 不能为空');
  if (input.create && this.resolver().listAgentIds().includes(id)) {
    throw new Error(`智能体 ID "${id}" 已存在`);
  }
```

Add the removal method immediately after `upsertAgent`:

```ts
removeAgent(rawId: string): object {
  const id = rawId.trim();
  if (!id) throw new Error('智能体 ID 不能为空');
  const writer = new ConfigWriter(this.configPath);
  writer.removeAgent(id);
  this.info('已删除智能体配置：' + id);
  return { ok: true };
}
```

- [ ] **Step 4: Run the service tests and verify they pass**

Run: `npx vitest run tests/gui-service.test.ts tests/config.test.ts`

Expected: PASS, including existing `ConfigWriter.removeAgent()` cleanup tests.

- [ ] **Step 5: Commit service behavior**

```bash
git add tests/gui-service.test.ts src/gui/service.ts
git commit -m "feat(gui): manage agent role lifecycle"
```

### Task 3: Delete IPC And Confirmed Renderer Action

**Files:**
- Modify: `tests/renderer-ui.test.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/app.js`

- [ ] **Step 1: Write failing delete-wiring contracts**

At the top of `tests/renderer-ui.test.ts`, load the two IPC sources:

```ts
const preload = readFileSync(resolve(rendererDir, 'preload.cjs'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'src/gui/main.ts'), 'utf8');
```

Append this test:

```ts
it('routes confirmed agent deletion through the service boundary', () => {
  const controller = section(app, '// 5.5 智能体角色管理', '// 6. 模型目录管理');
  expect(preload).toContain("removeAgent: (id) => call('gui:removeAgent', id)");
  expect(main).toContain("ipcMain.handle('gui:removeAgent'");
  expect(main).toContain('service.removeAgent(id)');
  expect(controller).toContain('window.deleteAgentRole = async');
  expect(controller).toContain('await showConfirm({');
  expect(controller).toContain('await window.hap.removeAgent(agentId)');
  expect(controller).toContain('配置与引用将被删除');
  expect(controller).toContain('工作目录、记忆和会话文件会保留');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/renderer-ui.test.ts`

Expected: FAIL because the bridge, handler, and renderer delete action are absent.

- [ ] **Step 3: Add the preload and main-process bridge**

After `upsertAgent` in `src/gui/renderer/preload.cjs`, add:

```js
removeAgent: (id) => call('gui:removeAgent', id),
```

After the `gui:upsertAgent` registration in `src/gui/main.ts`, add:

```ts
ipcMain.handle('gui:removeAgent', (_event, id) => invoke(() => service.removeAgent(id)));
```

- [ ] **Step 4: Render and handle the delete action**

Use `escJs()` for every role ID interpolated into inline handlers. Replace the agent-card footer actions with:

```js
<div style="display:flex;gap:6px;margin-left:auto;flex-wrap:wrap;">
  <button type="button" class="btn danger" onclick="deleteAgentRole('${escJs(agent.id)}')">删除</button>
  <button type="button" class="btn secondary" onclick="openAgentDialog('${escJs(agent.id)}')">编辑配置</button>
  <button type="button" class="btn primary" onclick="startChatWithAgent('${escJs(agent.id)}')">开始对话</button>
</div>
```

Add the handler below `window.openAgentDialog`:

```js
window.deleteAgentRole = async (agentId) => {
  const agent = (state.agents || []).find((item) => item.id === agentId);
  if (!agent) return;

  const ok = await showConfirm({
    title: '删除智能体角色',
    message: `确定删除 <strong>${esc(agent.displayName || agent.name || agent.id)}</strong>（${esc(agent.id)}）吗？<br><br>配置与引用将被删除；工作目录、记忆和会话文件会保留。`,
    okText: '确认删除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeAgent(agentId);
    showToast(`智能体 [${agentId}] 已删除`, 'success');
    await refresh();
  } catch (error) {
    showToast('删除智能体失败：' + error.message, 'error');
  }
};
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `npx vitest run tests/renderer-ui.test.ts tests/gui-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the delete workflow**

```bash
git add tests/renderer-ui.test.ts src/gui/renderer/preload.cjs src/gui/main.ts src/gui/renderer/app.js
git commit -m "feat(gui): add safe agent role deletion"
```

### Task 4: Regression And Visual Verification

**Files:**
- Modify only if verification finds a scoped defect in the files above.

- [ ] **Step 1: Run all automated verification**

Run:

```bash
npm run typecheck
npx vitest run tests/renderer-ui.test.ts tests/gui-service.test.ts tests/config.test.ts
npm test
npm run lint
npm run build
```

Expected: every command exits with status 0. Any pre-existing unrelated lint or test failure must be recorded separately and must not be hidden by changing unrelated code.

- [ ] **Step 2: Launch the Electron GUI**

Run: `npm run gui`

Expected: the application opens on the local desktop without renderer console errors.

- [ ] **Step 3: Verify the user workflow**

In the agent-role management view:

1. Open `新增角色` and verify the ID is editable and focused.
2. Cancel and reopen; verify stale form values are cleared.
3. Create a temporary role with a unique ID and verify it appears in the grid and role selectors.
4. Edit it and verify the ID is read-only while other fields persist.
5. Attempt a duplicate create and verify the dialog remains open with an error toast.
6. Open delete confirmation, cancel once, and verify the role remains.
7. Confirm deletion and verify the role disappears while the app remains responsive.
8. Resize to 900x700 and 720x600 and verify header actions, modal fields, and card footer actions neither overlap nor overflow.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- src/gui/renderer/index.html src/gui/renderer/app.js src/gui/renderer/preload.cjs src/gui/main.ts src/gui/service.ts tests/renderer-ui.test.ts tests/gui-service.test.ts
```

Expected: no whitespace errors, no unrelated files included, and no user changes reverted.

- [ ] **Step 5: Commit any verification-only fixes**

If Step 3 exposed a defect within this feature, fix it with a focused test first, rerun Step 1, then commit only those files:

```bash
git add <feature-files-only>
git commit -m "fix(gui): polish agent role management"
```
