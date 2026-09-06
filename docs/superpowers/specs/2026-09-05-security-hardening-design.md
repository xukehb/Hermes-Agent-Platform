# Security Hardening Design

## Goal

Close the highest-risk security gaps identified in the current platform without changing the existing agent protocol or GUI workflow. The first slice protects network entry points, makes control-plane policy effective at the final tool boundary, prevents SSRF and unbounded request handling, and improves remote credential persistence.

## Scope

### Web workbench

- Default `hap web` and `startWebServer` to loopback binding.
- Reject non-loopback binds unless an explicit authentication token is supplied.
- Apply authentication to the workbench HTML and static assets as well as `/api/*`.
- Add a minimal `/login` and `/auth/login` bootstrap that exchanges the user-entered token for an HttpOnly same-origin session cookie.
- Stop injecting the bearer token into HTML and stop printing it to logs.
- Remove query-string token authentication; accept only the `Authorization: Bearer` header.
- Configure CORS from an explicit allowlist. The default is same-origin/no cross-origin access.
- Add a bounded JSON body limit for write APIs.

### HTTP channel

- Add optional bearer-token authentication to `/run`, `/stream`, `/stop`, status and usage endpoints.
- Refuse public binds without a token.
- Bound request bodies and reject oversized inputs before task creation.

### Control-plane policy

- Replace the current command-kind fallback with a default-deny capability matrix.
- `observe` permits only read-only status, trace, usage, model and agent inspection.
- `operate` is required for prompts and mutable operations, subject to role.
- `admin` does not bypass an `observe` profile.
- Apply a second policy check inside `ToolExecutor` to every built-in and MCP tool.
- Scope remote server selection, including `remote_list_servers`, to the bound server.
- Add a small approval service for policies that require approval. Approvals bind to request id, operator, binding, tool, argument digest and expiry; any mismatch invalidates the approval.
- Emit audit records for allow, deny, approval creation, approval decision and execution result.

### Network and process safety

- `http_fetch` blocks loopback, private, link-local, multicast, unspecified and cloud metadata destinations by default.
- Validate every redirect destination and allow an explicit host allowlist for trusted internal services.
- Add body, output, concurrency and queue limits to HTTP and remote daemon paths.
- Kill or terminate remote daemon child processes when the client disconnects or the request times out.

### Remote credentials and daemon

- Store `servers.json` with mode `0600` and use random temporary files plus fsync and atomic rename.
- Preserve the current JSON format for compatibility in this slice; migrate to a system credential store separately.
- Default the generated daemon to loopback binding. Keep public deployment possible only through an explicit installer option.
- Keep SSH fallback as the secure transport; do not silently treat unauthenticated HTTP as a valid control path.

## Non-goals

- No BotRuntimeSupervisor implementation in this slice.
- No migration of legacy Telegram/Feishu/WeChat startup paths.
- No GUI decomposition.
- No breaking change to existing local CLI behavior when it is already bound to loopback.

## Testing

- Add Web tests for root/static authentication, no token injection, non-loopback validation, CORS and body limits.
- Add control-plane tests for the complete role/profile matrix, default-deny behavior, approvals and server scoping.
- Add ToolExecutor tests proving local tools are denied in observe mode and approvals are required/consumed exactly once.
- Add `http_fetch` tests for loopback/private/redirect blocking and allowlisted destinations.
- Add remote storage tests for file mode and atomic replacement.
- Add HTTP/daemon tests for oversized bodies and client disconnect cleanup where the current test seams permit it.

## Acceptance criteria

1. A default `hap web` instance is reachable only from the local machine.
2. A non-loopback Web or HTTP channel cannot start without explicit authentication.
3. No authentication token appears in served HTML or normal startup logs.
4. A viewer or an observe binding cannot invoke prompts, shell, file writes, remote execution or MCP mutations.
5. Every tool execution in a control session passes the same final policy check.
6. `http_fetch` cannot reach local/private/cloud-metadata addresses unless explicitly allowlisted.
7. Existing typecheck, build and test suites pass, with new regression tests included.
