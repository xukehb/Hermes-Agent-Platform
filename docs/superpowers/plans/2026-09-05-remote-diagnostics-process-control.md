# Remote Diagnostics and Process Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote disk scans report real data and add a safe, detailed remote process list with controlled termination from the desktop and web workbenches.

**Architecture:** Keep local disk and host monitoring behavior intact. Add structured process list/kill endpoints to the generated Daemon, with SSH command fallbacks for older Daemons. Put remote disk parsing and cleanup mapping in the remote client layer, then expose the same operations through GUI IPC and the web adapter. The renderer uses server IDs end-to-end and only enables kill controls for remote nodes.

**Tech Stack:** Node.js 20+, TypeScript, Electron IPC/preload, Hono, Vitest, generated zero-dependency Node Daemon.

## Global Constraints

- Never return hard-coded remote disk sizes or success values.
- Never concatenate user-provided PID, signal, or process text into an unrestricted shell command.
- Accept only numeric PIDs and `TERM`/`KILL`; reject PID 1, the Daemon PID, and the current process.
- Preserve unrelated dirty-worktree changes and the previous Telegram fix.
- Keep local process termination out of scope for this iteration.

### Task 1: Remote contracts, parsing, and Daemon endpoints

**Files:**
- Modify: `src/remote/types.ts`
- Modify: `src/remote/daemon-script.ts`
- Create: `src/remote/diagnostics.ts`
- Test: `tests/remote-diagnostics.test.ts`

**Interfaces:**
- Produce `RemoteProcess`, `RemoteProcessList`, `RemoteProcessSignal`, `RemoteProcessKillResult`, and optional disk fields on `RemoteSystemInfo`.
- Produce `parseRemoteProcessOutput()`, `parseRemoteDiskOutput()`, and static cleanup command mapping used by the client.
- Daemon exposes `GET /api/processes?limit=<n>` and `POST /api/processes/<pid>/kill` with `{signal:"TERM"|"KILL", expectedStartTime?:string}`.

- [ ] Write failing parser and Daemon contract tests for real `df/du` values, process fields, auth, invalid PID, and protected PID rejection.
- [ ] Run `npm test -- tests/remote-diagnostics.test.ts` and confirm the new expectations fail.
- [ ] Implement the shared parsers and generated Daemon handlers with bounded limits, static commands, and process protection.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Remote client operations and accurate disk cleanup

**Files:**
- Modify: `src/remote/client.ts`
- Modify: `src/remote/index.ts` (only if exports are needed)
- Modify: `src/gui/service.ts` (`scanDiskCleanable`, `executeDiskCleanup`, process methods)
- Test: `tests/remote.test.ts`
- Test: `tests/gui-remote-ops.test.ts`

**Interfaces:**
- `RemoteClientManager.listProcesses(config, options?)` returns `RemoteProcessList`.
- `RemoteClientManager.killProcess(config, pid, signal, expectedStartTime?)` returns `RemoteProcessKillResult`.
- `RemoteClientManager.scanDisk(config)` returns a `DiskScanReport` using parsed, actual sizes and stable item IDs.
- `RemoteClientManager.cleanDisk(config, itemIds)` rescans before/after, executes only known selected IDs, and reports actual deltas/errors.
- `GuiService.getServerProcesses(id, options?)` and `GuiService.killServerProcess(payload)` are the GUI service boundary.

- [ ] Add failing tests for daemon protocol responses, SSH fallback parsing, selected-item cleanup, and actual byte deltas.
- [ ] Run the focused tests and confirm they fail for the current hard-coded implementation.
- [ ] Implement HTTP calls with 404 fallback, safe SSH commands, real remote disk parsing, and server-ID resolution.
- [ ] Run focused tests plus `npm run typecheck`.

### Task 3: GUI and web integration

**Files:**
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/preload.cjs`
- Modify: `src/gui/renderer/index.html`
- Modify: `src/gui/renderer/app.js`
- Modify: `src/web/server.ts`
- Test: `tests/renderer-ui.test.ts`
- Test: `tests/web-server.test.ts`

**Interfaces:**
- Add IPC/preload methods `getServerProcesses`, `killServerProcess`.
- Remote panorama renders detailed process rows and refresh/TERM/KILL actions; local rows remain read-only.
- Disk scan/cleanup always passes `activePanoramaTarget` and preserves server IDs.
- Web `/api/disk/scan?server=<id>` and `/api/disk/clean` with `server` delegate to the same remote service; web polyfill exposes process methods.

- [ ] Add failing renderer and web contract assertions for target propagation, process controls, and server-aware disk routes.
- [ ] Implement the IPC/preload, renderer, and web adapter changes.
- [ ] Run focused renderer/web tests.

### Task 4: Full verification and review

**Files:**
- No new production files; review all touched files and generated protocol output.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck` and `git diff --check`.
- [ ] Inspect the final diff for hard-coded remote values, unsafe PID interpolation, stale target-name usage, and regressions to the Telegram fix.
- [ ] Request a focused code review of the complete diff and address critical/major findings.

