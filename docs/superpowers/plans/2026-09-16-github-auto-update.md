# GitHub Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a startup-only GitHub Release update check with an in-app one-click download and install flow for Hermes Agent Platform 0.1.4.

**Architecture:** A focused main-process `DesktopUpdateController` wraps `electron-updater` and emits serializable states. `main.ts` owns the controller, exposes three IPC commands, and forwards state events through the existing preload bridge. The renderer displays those states in an existing-style dialog, while electron-builder and the release workflow publish installers plus updater metadata.

**Tech Stack:** Electron 37, TypeScript, electron-updater 6.8.9, electron-builder 26.15.3, vanilla HTML/CSS/JavaScript, Vitest, GitHub Actions.

---

### Task 1: Update controller state machine

**Files:**
- Create: `src/gui/desktop-updater.ts`
- Create: `tests/desktop-updater.test.ts`

- [ ] **Step 1: Write failing controller tests**

Cover packaged/development startup behavior, one-time checking, available version mapping, progress mapping, download errors, downloaded state, duplicate download suppression, and install delegation with a fake updater adapter.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/desktop-updater.test.ts`

Expected: FAIL because `src/gui/desktop-updater.ts` does not exist.

- [ ] **Step 3: Implement the controller**

Define discriminated `DesktopUpdateState` values for `idle`, `checking`, `available`, `downloading`, `downloaded`, and `error`. Implement `checkOnStartup()`, `download()`, `quitAndInstall()`, `getState()`, and state subscriptions. Configure `autoDownload = false` and `autoInstallOnAppQuit = false`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/desktop-updater.test.ts`

Expected: all controller tests pass.

### Task 2: Main-process and preload integration

**Files:**
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Create: `tests/gui-auto-update-contract.test.ts`

- [ ] **Step 1: Write failing IPC contract tests**

Assert that preload exposes `getUpdateState`, `downloadUpdate`, `installUpdate`, and `onUpdateState`; main registers matching IPC handlers; startup check occurs after the main window is ready; unsubscribe removes only the registered listener.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `npx vitest run tests/gui-auto-update-contract.test.ts`

Expected: FAIL because update IPC contracts are absent.

- [ ] **Step 3: Wire the update controller**

Instantiate the controller with `electron-updater`, forward state events to `mainWindow.webContents.send('gui:update:state', state)`, register the three invoke handlers, expose the preload APIs, and trigger one startup check after `did-finish-load`.

- [ ] **Step 4: Run contract and controller tests**

Run: `npx vitest run tests/desktop-updater.test.ts tests/gui-auto-update-contract.test.ts`

Expected: all tests pass.

### Task 3: In-app update dialog

**Files:**
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/app.js`
- Modify: `src/gui/renderer/styles.css`
- Modify: `src/gui/renderer/i18n.js`
- Modify: `tests/gui-auto-update-contract.test.ts`

- [ ] **Step 1: Add failing renderer assertions**

Assert the dialog has stable version, notes, progress, error and action regions; renderer subscribes before fetching current state; available state opens the dialog; download, retry, defer and install buttons call the correct preload APIs; progress formatting is bounded from 0 to 100.

- [ ] **Step 2: Run renderer contract tests and verify RED**

Run: `npx vitest run tests/gui-auto-update-contract.test.ts`

Expected: FAIL on missing dialog and renderer behavior.

- [ ] **Step 3: Implement dialog markup, behavior, styles, and translations**

Add one un-nested `<dialog>` with fixed responsive dimensions. Render version details and sanitized text release notes, display progress and retryable errors, and keep action buttons state-specific. Add Chinese and English strings to the existing i18n dictionary.

- [ ] **Step 4: Run GUI-focused tests**

Run: `npx vitest run tests/gui-auto-update-contract.test.ts tests/renderer-ui.test.ts tests/gui-i18n.test.ts`

Expected: all tests pass.

### Task 4: Packaging and GitHub Release metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/package-scripts.test.ts`
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] **Step 1: Write failing packaging contract tests**

Require version `0.1.4`, `electron-updater` as a runtime dependency, GitHub publish configuration, macOS `dmg` plus `zip`, updater-compatible artifact metadata, workflow upload globs for YAML/blockmap/ZIP assets, and a legacy-name rejection step.

- [ ] **Step 2: Run package tests and verify RED**

Run: `npx vitest run tests/package-scripts.test.ts`

Expected: FAIL on the old version and missing updater configuration.

- [ ] **Step 3: Update dependency and builder configuration**

Install `electron-updater@6.8.9`, bump to `0.1.4`, configure GitHub publishing for `xukehb/Hermes-Agent-Platform`, add macOS ZIP targets, retain user-facing DMG/DEB/EXE artifacts, and document startup update behavior plus unsigned-package caveats.

- [ ] **Step 4: Update release workflow**

Upload updater YAML, blockmaps and macOS ZIP files alongside installers. Make titles and release bodies derive from the package/tag version rather than hard-coding `0.1.3`. Validate the artifact whitelist before publication.

- [ ] **Step 5: Run packaging contract tests**

Run: `npx vitest run tests/package-scripts.test.ts tests/gui-auto-update-contract.test.ts`

Expected: all tests pass.

### Task 5: Full verification and release

**Files:**
- Modify: `.codex/testing.md`
- Modify: `.codex/review-report.md`
- Modify: `.codex/operations-log.md`
- Modify: `verification.md`

- [ ] **Step 1: Run static and focused verification**

Run under Node 22.23.2: `npm run typecheck`, `npm run lint`, focused updater tests, and `npm run build`.

- [ ] **Step 2: Run the complete test suite**

Run: `npm run rebuild:node && npm test`

Expected: all test files and assertions pass.

- [ ] **Step 3: Build and inspect the Linux package metadata locally**

Run: `npm run dist:linux -- --x64` and inspect the generated DEB plus `latest-linux.yml`.

Expected: version 0.1.4, Hermes product identity, executable present, updater metadata references the matching DEB.

- [ ] **Step 4: Record verification evidence and commit**

Record commands, outputs, known unsigned-package limitations, and review score in the four audit files. Commit only task-owned files while preserving pre-existing user changes.

- [ ] **Step 5: Publish and verify v0.1.4**

Push `main`, create and push tag `v0.1.4`, wait for the native runner workflow, then query the public GitHub Release API. Verify the formal release, all platform installers, updater metadata, and absence of legacy product names.
