# Agent Role GUI Management Design

**Date:** 2026-08-30

## Goal

Complete the Electron agent-role management GUI so users can create and delete agent roles in addition to editing and starting conversations with them.

## Scope

The change covers the existing `agents` view, its shared create/edit dialog, Electron IPC wiring, and `GuiService`. It reuses `ConfigWriter.upsertAgent()` and `ConfigWriter.removeAgent()` as the configuration boundary.

The change does not add template selection, role cloning, role ID renaming, batch deletion, or deletion of workspace, memory, and session files.

## User Interface

### Create

- Add a primary `新增角色` button to the agent-role page header.
- Opening it resets the existing agent dialog into create mode.
- Create mode shows an editable required role ID field.
- The ID uses the configuration layer's supported identifier format and must not duplicate an existing role.
- Display name, emoji, primary model, tool tier, workspace, and description reuse the existing fields.
- The submit button and modal title clearly indicate creation.

### Edit

- The existing `编辑配置` action continues to open the same dialog.
- Edit mode displays the role ID as read-only so an edit cannot silently become a rename.
- The remaining fields keep their current behavior.

### Delete

- Add a danger-styled `删除` action to every role card.
- Before deletion, show the existing confirmation dialog with the role name and ID.
- The confirmation explains that role configuration and references are removed while workspace, memory, and session files remain on disk.
- After successful deletion, close any transient state, show a success toast, and refresh the snapshot so all role selectors update.

## Data Flow

Creation and editing call the existing renderer bridge method `window.hap.upsertAgent(input)`. `GuiService.upsertAgent()` validates the input and persists it through `ConfigWriter.upsertAgent()`.

Deletion adds a narrow path:

1. The renderer calls `window.hap.removeAgent(id)` after confirmation.
2. The preload bridge invokes `gui:removeAgent`.
3. The Electron main process delegates to `GuiService.removeAgent(id)`.
4. The service calls `ConfigWriter.removeAgent(id)`.
5. The existing writer removes the entry and clears configuration references such as `default_agent`, channel defaults, profile defaults, and `subagents.allow` entries.
6. The renderer refreshes the full GUI snapshot.

The GUI will not directly edit TOML or duplicate reference-cleanup logic.

## Validation And Errors

- Reject an empty role ID before IPC submission.
- Reject duplicate IDs in create mode before IPC submission, while retaining service/configuration validation as the authoritative guard.
- Normalize the submitted ID by trimming surrounding whitespace; the ID itself is not changed otherwise.
- Surface service and configuration errors through the existing toast mechanism.
- Keep the dialog open when creation or editing fails so entered values are not lost.
- Keep the role card visible when deletion fails.

## Data Retention

Deletion removes only the role's configuration entry and configuration references. It does not remove the agent directory, workspace, memory, generated files, or conversation/session history. This matches the existing CLI removal contract and prevents irreversible GUI data loss.

## Testing

- Renderer contract tests verify the page exposes an add action, the shared dialog supports create and edit modes, and cards expose a confirmed delete action.
- Preload/main wiring tests or source contracts verify `removeAgent` is exposed and registered.
- Service tests verify creation delegates to the writer, deletion succeeds for a declared role, missing roles return an error, and configuration reference cleanup remains owned by `ConfigWriter`.
- Run the relevant Vitest suite, TypeScript type checking, and linting available in the repository.
- Launch the Electron app and verify create, edit, cancel, delete confirmation, deletion refresh, and error feedback at desktop and constrained window sizes.

## Acceptance Criteria

- A user can create a new role entirely from the agent-role management page.
- The new role appears in the role grid and other role selectors after refresh.
- A user cannot accidentally change an existing role's ID while editing.
- A user can delete a role only after explicit confirmation.
- Deletion removes stale configuration references without deleting role-owned files.
- Failed operations provide actionable feedback and do not falsely update the UI.
