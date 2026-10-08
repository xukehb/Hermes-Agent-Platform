import { describe, expect, it } from 'vitest';
import { WorkspaceSandbox } from '../src/tools/sandbox/workspace-sandbox.js';
import { join } from 'node:path';

describe('WorkspaceSandbox Guard', () => {
  const workspace = '/Users/test/projects/my-app';

  it('allows paths inside workspace', () => {
    const result = WorkspaceSandbox.isPathAllowed(join(workspace, 'src', 'index.ts'), workspace);
    expect(result.allowed).toBe(true);
  });

  it('blocks path traversal attacks attempting to escape workspace', () => {
    const result = WorkspaceSandbox.isPathAllowed(join(workspace, '..', '..', 'etc', 'passwd'), workspace);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('越界');
  });

  it('blocks access to sensitive system paths even if referenced directly', () => {
    expect(WorkspaceSandbox.isPathAllowed('/etc/shadow', workspace).allowed).toBe(false);
    expect(WorkspaceSandbox.isPathAllowed('/etc/sudoers', workspace).allowed).toBe(false);
    expect(WorkspaceSandbox.isPathAllowed('/System/Library/CoreServices', workspace).allowed).toBe(false);
    expect(WorkspaceSandbox.isPathAllowed('~/.ssh/id_rsa', workspace).allowed).toBe(false);
  });

  it('blocks URL-encoded path traversal attacks', () => {
    const encoded = '%2e%2e%2f%2e%2e%2fetc%2fpasswd';
    const result = WorkspaceSandbox.isPathAllowed(join(workspace, encoded), workspace);
    expect(result.allowed).toBe(false);
  });

  it('detects dangerous destructive shell commands', () => {
    expect(WorkspaceSandbox.isDangerousCommand('rm -rf /').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand('rm -rf /*').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand('rm -rf $HOME').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand(':(){ :|:& };:').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand('mkfs.ext4 /dev/sda1').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand('dd if=/dev/zero of=/dev/sda').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand('chmod -R 777 /').dangerous).toBe(true);
    expect(WorkspaceSandbox.isDangerousCommand('Remove-Item -Recurse -Force C:\\').dangerous).toBe(true);
  });

  it('allows safe shell commands', () => {
    expect(WorkspaceSandbox.isDangerousCommand('git status').dangerous).toBe(false);
    expect(WorkspaceSandbox.isDangerousCommand('npm run test').dangerous).toBe(false);
    expect(WorkspaceSandbox.isDangerousCommand('rm -rf dist').dangerous).toBe(false);
  });
});
