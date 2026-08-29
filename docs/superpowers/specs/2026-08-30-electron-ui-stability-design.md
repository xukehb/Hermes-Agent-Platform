# Electron UI Stability Design

**Goal:** Resolve all eight findings in `dogfood-output/report.md` without replacing the existing application structure or visual language.

## Scope

The implementation covers the broken modal hierarchy, modal close-button accessibility, Scheduled Tasks routing, new-chat composer reset, settings-tab state, local disk percentage, local process collection, and public-IP loading. The WeChat layout is included in responsive verification because the current build no longer reproduces the earlier blank-page report; no speculative rewrite will be made to a layout that now renders correctly.

## Architecture

The renderer remains a plain HTML/CSS/JavaScript Electron surface. The malformed confirmation dialog will be closed at the correct DOM level so every later dialog is a top-level sibling. Close controls will share one accessible icon-button contract: fixed dimensions, a CSS-rendered close glyph, `aria-label="关闭"`, and `title="关闭"`.

The panorama page will have one `window.refreshHostView` controller. Its local branch will render CPU, memory, disks, processes, network interfaces, and IP geolocation; its remote branch will preserve the current server behavior. Public-IP lookup will use a short-lived cache plus an in-flight promise so the three-second dashboard poll cannot trigger overlapping external requests.

Navigation and local UI state will be corrected at their source. Scheduled Tasks will route to `schedules`; a new conversation will clear text and attachments and recompute send-button state; settings tabs will toggle the `active` class only within `.settings-nav-tabs`.

On Unix hosts, process collection will use portable `ps -axo pid=,rss=,comm=` output and sort parsed rows in JavaScript. This avoids GNU-only `--sort` on macOS while retaining the existing 30-second cache.

## Error Handling

Dashboard refresh keeps its concurrency lock and reports refresh failures to the console without leaving the lock set. IP lookup renders an explicit failure state and may retry on a later cache miss. Empty process or network results render a visible empty state instead of an unpainted panel.

## Verification

Vitest will enforce renderer source contracts and exercise host process collection. The regression test must fail against the current sources before implementation. Final verification consists of the complete test, typecheck, lint, and build commands plus Electron/CDP clicks for all eight findings at desktop, 900x700, and 720x600 viewports. The dogfood report will record the verified result for each issue.

