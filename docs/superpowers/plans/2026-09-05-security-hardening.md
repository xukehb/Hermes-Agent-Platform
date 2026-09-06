# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the highest-risk Web, control-plane, SSRF, request-lifecycle, and remote-credential vulnerabilities while preserving existing local CLI behavior.

**Architecture:** Add small policy and network-boundary helpers instead of spreading checks through handlers. Authentication is enforced at the transport boundary, while control authorization is enforced again in `ToolExecutor`; storage changes retain the existing JSON format but use safe file replacement.

**Tech Stack:** TypeScript, Hono, Node `http`, Zod, Vitest, better-sqlite3.

## Global Constraints

- Default network listeners remain local-only unless explicit authentication is configured.
- Control-plane decisions are default-deny and use the intersection of role and capability profile.
- Existing agent protocol and local CLI behavior must remain compatible.
- Every production behavior change gets a regression test before implementation.
- Do not modify unrelated user changes already present in the worktree.

---

### Task 1: Secure the Web Workbench Boundary

**Files:**
- Modify: `src/web/server.ts:17-63,267-430`
- Modify: `src/cli/web-commands.ts:5-25`
- Test: `tests/web-server.test.ts`

**Interfaces:**
- `WebServerOptions` gains `corsOrigins?: string[]` and `maxBodyBytes?: number`.
- `createWebApp` authenticates `/`, static assets, and `/api/*` using only `Authorization: Bearer`.
- `startWebServer` rejects non-loopback binds when `auth` is absent and defaults to `127.0.0.1`.

- [ ] **Step 1: Write failing tests** for unauthenticated root/static rejection, no token in HTML, query-token rejection, non-loopback-without-auth rejection, and bounded JSON bodies.
- [ ] **Step 2: Run `npm test -- tests/web-server.test.ts` and confirm the new tests fail for the expected missing behavior.**
- [ ] **Step 3: Implement a shared bearer middleware, loopback validation, explicit CORS origin handling, and a body-size guard. Remove `window.authToken` injection and token startup logging.
- [ ] **Step 4: Run `npm test -- tests/web-server.test.ts` and confirm all Web tests pass.**
- [ ] **Step 5: Commit only the Web boundary changes and tests.**

### Task 2: Authenticate and Bound the HTTP Channel

**Files:**
- Modify: `src/channels/http.ts:20-250`
- Test: `tests/channels-http.test.ts`

**Interfaces:**
- HTTP channel options gain `authToken?: string` and `maxBodyBytes?: number`.
- Public binds without `authToken` throw a configuration error before listening.

- [ ] **Step 1: Add failing tests for public-bind rejection, missing/invalid bearer tokens, accepted local authenticated calls, and oversized bodies.**
- [ ] **Step 2: Run the focused HTTP channel tests and confirm failure.**
- [ ] **Step 3: Add auth middleware before all status/run/stream/stop handlers and reject oversized bodies before `c.req.json()`.**
- [ ] **Step 4: Run the focused tests and then `npm test -- tests/channels-http.test.ts`.**
- [ ] **Step 5: Commit the HTTP channel changes and tests.**

### Task 3: Make Control Authorization Default-Deny

**Files:**
- Modify: `src/control-plane/authorization.ts:12-103`
- Modify: `src/control-plane/types.ts:84-102`
- Test: `tests/control-plane-authorization.test.ts`

**Interfaces:**
- Export `isCommandAllowed(role, profile, commandKind): boolean` with explicit read/operate sets.
- `admin` is subject to `observe` and cannot bypass the profile.
- `prompt` is operate-only; unknown commands are denied.

- [ ] **Step 1: Add a complete role/profile matrix test, including admin+observe, operator+observe prompt, viewer+operate prompt, and unknown commands.**
- [ ] **Step 2: Run the focused test and confirm the current implementation fails.**
- [ ] **Step 3: Replace the fallback logic with explicit default-deny checks and export the pure policy function.**
- [ ] **Step 4: Run `npm test -- tests/control-plane-authorization.test.ts`.**
- [ ] **Step 5: Commit the authorization changes and tests.**

### Task 4: Enforce Policy at Tool Execution and Add Approval Records

**Files:**
- Modify: `src/control-plane/scoped-tools.ts`
- Modify: `src/control-plane/store.ts:52-71,328-350`
- Create: `src/control-plane/policy.ts`
- Modify: `src/tools/executor.ts:54-81`
- Modify: `src/tools/builtin/remote-tools.ts:45-73`
- Test: `tests/tools.test.ts`, `tests/control-plane-store.test.ts`

**Interfaces:**
- `evaluateToolPolicy(toolName, args, context)` returns `{ decision: 'allow' | 'deny' | 'approval_required'; reason: string }`.
- `ToolContext` may carry an approved request id and approval store.
- Remote server scoping includes `remote_list_servers` and returns only the bound server summary.

- [ ] **Step 1: Add failing tests for observe-mode denial of `shell`, `write_file`, `http_fetch`, MCP mutations, and remote server enumeration; add approval create/consume/expiry tests.**
- [ ] **Step 2: Run the focused tests and confirm the current executor allows or bypasses these cases.**
- [ ] **Step 3: Implement the policy module and call it after tool argument validation and before every handler invocation.**
- [ ] **Step 4: Implement transactional one-time approval persistence keyed by request, binding, operator, tool and argument digest.**
- [ ] **Step 5: Run `npm test -- tests/tools.test.ts tests/control-plane-store.test.ts tests/control-plane-authorization.test.ts`.**
- [ ] **Step 6: Commit the final-tool policy and approval changes.**

### Task 5: Block SSRF and Bound Remote/HTTP Request Lifecycles

**Files:**
- Create: `src/security/network-policy.ts`
- Modify: `src/tools/builtin/http-fetch.ts:17-51`
- Modify: `src/remote/daemon-script.ts:110-288`
- Modify: `src/channels/http.ts:120-210`
- Test: `tests/tools.test.ts`, `tests/remote-client-ops.test.ts`, `tests/channels-http.test.ts`

**Interfaces:**
- `assertFetchTarget(url, allowHosts?)` rejects loopback, private, link-local, multicast, unspecified and metadata destinations.
- Redirects are checked one hop at a time and output/body limits are enforced.

- [ ] **Step 1: Add failing tests for loopback/private/metadata rejection, redirect-to-private rejection, and explicit allowlist acceptance.**
- [ ] **Step 2: Run focused tests and confirm the unfiltered fetch currently reaches local services.**
- [ ] **Step 3: Resolve DNS addresses before fetch, reject disallowed ranges, use bounded response reads, and disable unsafe redirects unless each target passes validation.**
- [ ] **Step 4: Add daemon request byte limits, output limits, concurrency limits, and `req.on('close')` child cleanup.**
- [ ] **Step 5: Run focused tests and the full tool/channel/remote test groups.**
- [ ] **Step 6: Commit network and lifecycle changes.**

### Task 6: Harden Remote Credential Storage and Daemon Defaults

**Files:**
- Modify: `src/remote/storage.ts:5-115`
- Modify: `src/remote/daemon-script.ts:286-288`
- Modify: `src/remote/ssh-installer.ts:199-255`
- Test: `tests/remote.test.ts`

**Interfaces:**
- `RemoteServerStore` keeps the current JSON schema and public CRUD methods.
- Writes use a random sibling temp file, `fsync`, atomic rename, mode `0600`, and parent directory mode `0700` where supported.
- Generated daemon scripts bind loopback by default and require an explicit public-bind option.

- [ ] **Step 1: Add failing tests for file and directory modes and concurrent-safe replacement semantics.**
- [ ] **Step 2: Run the focused remote storage tests and confirm the current direct write behavior.**
- [ ] **Step 3: Implement safe writes without changing the serialized fields.**
- [ ] **Step 4: Change daemon generation to loopback default and add installer-side checksum verification for the pinned Node tarball.**
- [ ] **Step 5: Run `npm test -- tests/remote.test.ts` and the full suite.**
- [ ] **Step 6: Commit remote storage and daemon hardening.**

### Task 7: Final Verification

**Files:**
- Modify: `package.json` only if a missing test dependency is required for the existing command.
- Test: all existing tests plus the focused suites above.

- [ ] **Step 1: Run `npm run typecheck`.**
- [ ] **Step 2: Run `npm test` after rebuilding `better-sqlite3` if the local ABI is stale.**
- [ ] **Step 3: Run `npm run build`.**
- [ ] **Step 4: Run `git diff --check` and inspect the final diff for unrelated changes.**
- [ ] **Step 5: Report any remaining lint/coverage dependency gaps without claiming them fixed.**
