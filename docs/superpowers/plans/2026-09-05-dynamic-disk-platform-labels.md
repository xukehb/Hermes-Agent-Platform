# Dynamic Disk Scanner Platform Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make disk scanner labels and progress copy match the active local or remote operating system.

**Architecture:** Keep `scannedRoots` as the actual path list and add normalized platform metadata to `DiskScanReport`. A renderer helper consumes both fields so every scanner message uses the same target context, with compatibility fallbacks for older reports.

**Tech Stack:** TypeScript, Electron renderer JavaScript, Vitest.

---

### Task 1: Add report metadata tests

**Files:**
- Modify: `tests/disk-cleaner.test.ts`
- Modify: `tests/gui-remote-ops.test.ts`
- Modify: `tests/renderer-ui.test.ts`

- [ ] **Step 1: Add local report expectations**

Assert that `scanLocalDisk()` returns a string `platform` and a human-readable `platformLabel`.

- [ ] **Step 2: Add remote report expectations**

Extend the remote scan fixture to return a Linux system info value and assert the resulting report carries `platform: 'linux'` and `platformLabel: 'Linux'`.

- [ ] **Step 3: Add renderer contract assertions**

Assert that the renderer defines a platform context helper and that scanner progress/result paths use it rather than the literal `C:\\, D:\\` copy.

- [ ] **Step 4: Run the focused tests and verify the new expectations fail**

Run `npm test -- --run tests/disk-cleaner.test.ts tests/gui-remote-ops.test.ts tests/renderer-ui.test.ts`.

Expected: the new metadata and renderer assertions fail before implementation.

### Task 2: Implement platform-aware report metadata

**Files:**
- Modify: `src/system/disk-cleaner.ts`
- Modify: `src/gui/service.ts`

- [ ] **Step 1: Extend `DiskScanReport`**

Add `platform: NodeJS.Platform | string` and `platformLabel: string` fields.

- [ ] **Step 2: Add a small platform label helper**

Map `win32` to `Windows`, `darwin` to `macOS`, `linux` to `Linux`, and unknown values to `Remote host` or `当前系统` at the caller boundary.

- [ ] **Step 3: Return local metadata**

Use `process.platform` and the helper in `scanLocalDisk()`.

- [ ] **Step 4: Return remote metadata**

Read the remote system info from the existing remote client result when available, normalize its platform, and fall back to `linux` only for the existing legacy mock response. Set the neutral label when the platform is unavailable.

- [ ] **Step 5: Run focused tests and verify they pass**

Run `npm test -- --run tests/disk-cleaner.test.ts tests/gui-remote-ops.test.ts`.

Expected: all focused backend tests pass.

### Task 3: Use one dynamic scanner context in the renderer

**Files:**
- Modify: `src/gui/renderer/app.js`
- Modify: `src/gui/renderer/index.html`

- [ ] **Step 1: Add renderer context helpers**

Normalize `platform`, derive the human label, format roots without stripping Unix root `/`, and provide a single `getDiskScanContext(report)` function with local/remote fallbacks.

- [ ] **Step 2: Replace hard-coded progress copy**

Build the first progress step from the active context roots, and use generic platform-neutral wording for the remaining steps.

- [ ] **Step 3: Replace hard-coded subtitle and empty-state copy**

Add an element for the active platform/roots summary and update it after scan completion; keep the initial subtitle generic until a report exists.

- [ ] **Step 4: Replace result badge and diagnosis copy**

Render `平台 · 根目录` in `diskRootsBadge`, and prepend the dynamic context to the existing diagnosis only when the report does not already contain platform-aware text.

- [ ] **Step 5: Run renderer contract tests**

Run `npm test -- --run tests/renderer-ui.test.ts`.

Expected: renderer tests pass and no scanner copy contains a universal Windows path.

### Task 4: Full verification

**Files:**
- No additional files.

- [ ] **Step 1: Run the full test suite**

Run `npm test -- --run`.

- [ ] **Step 2: Inspect the final diff**

Run `git diff --check` and `git diff -- src/system/disk-cleaner.ts src/gui/service.ts src/gui/renderer/app.js src/gui/renderer/index.html tests`.

- [ ] **Step 3: Confirm scope**

Ensure only dynamic platform metadata, scanner copy, and related tests/docs changed; preserve unrelated worktree changes.
