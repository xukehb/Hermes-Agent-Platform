# Electron UI Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix and verify all eight Electron UI findings documented by the 2026-08-30 dogfood run.

**Architecture:** Keep the renderer's current plain HTML/CSS/JavaScript design, repair the shared dialog root cause, and consolidate the duplicated panorama refresh path. Use Vitest source contracts for renderer regressions, a real host-info assertion for process collection, and Electron/CDP for end-to-end behavior.

**Tech Stack:** Electron 37, TypeScript 7, browser JavaScript, CSS, Vitest 4, agent-browser/CDP.

---

### Task 1: Add failing renderer contracts

**Files:**
- Create: `tests/renderer-ui.test.ts`
- Modify: `tests/host-info.test.ts`

- [ ] **Step 1: Write the failing tests**

Add source-contract assertions that dialogs are top-level siblings, all `.btn-close` buttons are named, Scheduled Tasks routes to `schedules`, new chat resets the composer, settings tabs toggle one scoped active class, only one panorama refresh controller exists, and its local branch consumes `usedPercent`, processes, network data, and IP lookup. Add a host-info assertion that Unix systems return at least one top process.

- [ ] **Step 2: Verify the tests fail for the expected defects**

Run: `npx vitest run tests/renderer-ui.test.ts tests/host-info.test.ts`

Expected: renderer contracts fail on malformed dialog nesting, unnamed close buttons, wrong route, retained composer, duplicate refresh controller, wrong disk field, and omitted process/IP rendering; the macOS process assertion fails because BSD `ps` rejects `--sort`.

### Task 2: Repair modal structure and close controls

**Files:**
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/styles.css`

- [ ] **Step 1: Close the confirmation dialog before the AI image dialog**

Insert the missing closing tags for the confirmation button row, `.modal-form-wrap`, and `confirmDialog`, making all following dialogs siblings.

- [ ] **Step 2: Normalize close-button markup and styling**

Give all 22 close buttons `aria-label="关闭"` and `title="关闭"`, remove inconsistent text glyphs, and render one stable glyph through `.btn-close::before`. Set a fixed 32x32 control size with visible focus styling.

- [ ] **Step 3: Run renderer contracts**

Run: `npx vitest run tests/renderer-ui.test.ts`

Expected: dialog and accessibility assertions pass while remaining behavior assertions still identify unimplemented fixes.

### Task 3: Fix navigation and local UI state

**Files:**
- Modify: `src/gui/renderer/app.js`

- [ ] **Step 1: Reset the new-chat composer**

Clear `chatInput`, reset `currentAttachments`, rerender attachments, call `updateComposerState()`, then focus the input after creating a new session.

- [ ] **Step 2: Correct Scheduled Tasks routing**

Change the top navigation handler from `show('logs')` to `show('schedules')`.

- [ ] **Step 3: Make settings active state exclusive**

Query only `.settings-nav-tabs .settings-tab-btn` and call `btn.classList.toggle('active', btn.dataset.tab === tabId)` instead of applying competing inline colors.

- [ ] **Step 4: Run renderer contracts**

Run: `npx vitest run tests/renderer-ui.test.ts`

Expected: navigation, composer, and tab-state assertions pass.

### Task 4: Consolidate the panorama data flow

**Files:**
- Modify: `src/gui/renderer/app.js`

- [ ] **Step 1: Remove the overwritten refresh implementation**

Keep one `window.refreshHostView` assignment and retain shared formatting, locking, and rendering helpers.

- [ ] **Step 2: Restore all local dashboard consumers**

Use `HostDiskPartition.usedPercent`, render `topProcesses`, render network interfaces, and invoke IP geolocation from the surviving local refresh branch. Provide explicit empty states.

- [ ] **Step 3: Bound IP geolocation requests**

Cache successful results for five minutes and reuse an in-flight promise so three-second polling never overlaps external lookups. Render `探测失败` on errors.

- [ ] **Step 4: Run renderer contracts**

Run: `npx vitest run tests/renderer-ui.test.ts`

Expected: all renderer contracts pass.

### Task 5: Make Unix process collection portable

**Files:**
- Modify: `src/system/host-info.ts`
- Test: `tests/host-info.test.ts`

- [ ] **Step 1: Replace GNU-only process sorting**

Run `ps -axo pid=,rss=,comm=` on non-Windows systems, parse PID/RSS/name, sort by RSS in JavaScript, and slice to the requested limit.

- [ ] **Step 2: Verify host behavior**

Run: `npx vitest run tests/host-info.test.ts`

Expected: host info includes a non-empty process list on macOS/Linux and all existing host assertions pass.

### Task 6: Full verification and report update

**Files:**
- Modify: `dogfood-output/report.md`
- Create: `dogfood-output/screenshots/fixed-*.png`

- [ ] **Step 1: Run repository verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command exits 0 with no test failures or lint errors.

- [ ] **Step 2: Rebuild and launch Electron with CDP**

Launch the built renderer on port 9333 and connect the existing `hermes-fix-diagnosis` agent-browser session.

- [ ] **Step 3: Replay all eight findings**

Verify AI image, environment, add-bot, and node-bot dialogs open and close; Scheduled Tasks opens schedules; new chat clears its draft; exactly one settings tab is active; disk/process/IP widgets resolve; close buttons expose `关闭`; WeChat stays compact and labeled.

- [ ] **Step 4: Verify responsive layouts**

Capture desktop, 900x700, and 720x600 screenshots and confirm no overlap, clipped controls, blank panels, or inaccessible dialog actions.

- [ ] **Step 5: Update the dogfood report**

Append a remediation section with code/test evidence and per-issue PASS results, distinguishing ISSUE-001 as not reproducible in the current build but covered by responsive verification.

