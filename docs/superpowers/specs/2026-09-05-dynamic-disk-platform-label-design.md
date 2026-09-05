# Dynamic Disk Scanner Platform Labels

## Goal

Make the disk scanner describe the operating system and root paths of the active scan target instead of showing Windows-specific paths on every platform.

## Scope

- Add normalized platform metadata to `DiskScanReport`.
- Derive local metadata from the actual Node.js runtime and discovered roots.
- Derive remote metadata from the remote host system information when available, with a neutral fallback.
- Use the metadata for the scanner subtitle, progress steps, result badge, empty state, and AI diagnosis text.
- Preserve scan, cleanup, and item-selection behavior.

## Behavior

| Target | Platform label | Example roots |
| --- | --- | --- |
| macOS | macOS | `/`, `/tmp`, `/var/tmp` |
| Linux | Linux | `/`, `/tmp`, `/var/tmp` |
| Windows | Windows | `C:\\`, `D:\\` |
| Unknown remote | Remote host | paths returned by the scan |

The UI must never hard-code `C:\\` or `D:\\` for non-Windows targets. Missing metadata falls back to `当前系统` locally or `远程主机` remotely.

## Data Flow

`scanLocalDisk` and remote scan construction return `platform` and `platformLabel`. The renderer normalizes older reports that do not contain these fields, then derives one shared context object for all scanner copy. Existing `scannedRoots` remains the source of truth for actual paths.

## Testing

- Unit tests verify platform normalization and local report metadata.
- Renderer contract tests verify the hard-coded Windows copy is gone and dynamic context is used by progress and result rendering.
- Existing disk cleaner and renderer tests must continue to pass.
