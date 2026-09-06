import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { GuiService } from '../src/gui/service.js';
import { buildHunkPatch } from '../src/tools/diff-parser.js';

describe('GUI Advanced Features (Task Abort, Hunk Staging, MCP Playground)', () => {
  let testDir: string;
  let configPath: string;
  let service: GuiService;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hap-gui-adv-'));
    configPath = join(testDir, 'config.toml');
    const configContent = [
      'default_agent = "assistant"',
      '',
      '[agents.defaults]',
      'model = { primary = "mock/model-a", fallbacks = [] }',
      `workspace_root = "${join(testDir, 'workspaces')}"`,
      `agent_dir_root = "${join(testDir, 'agents')}"`,
      '',
      '[agents.entries.assistant]',
      'description = "General Assistant"',
      '',
      '[paths]',
      `data_dir = "${join(testDir, 'data')}"`,
      '',
    ].join('\n');
    writeFileSync(configPath, configContent, 'utf8');
    service = new GuiService(configPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Task Abort Controller', () => {
    it('returns not ok when no active chat task is running', () => {
      const res = service.abortChat();
      expect(res.ok).toBe(false);
      expect(res.message).toContain('没有正在执行');
    });
  });

  describe('MCP Playground', () => {
    it('lists MCP playground tools gracefully when no external MCP is declared', async () => {
      const res = await service.listMcpPlaygroundTools();
      expect(res).toBeDefined();
      expect(Array.isArray(res.tools)).toBe(true);
      expect(res.serverCount).toBe(0);
      expect(res.failures).toEqual([]);
    });

    it('throws when calling a non-existent tool in MCP playground', async () => {
      await expect(
        service.callMcpPlaygroundTool({ toolName: 'non_existent/tool', args: {} })
      ).rejects.toThrow('找不到 MCP 工具');
    });
  });

  describe('Git Hunk Selective Stage and Revert', () => {
    let repoDir: string;
    let testFilePath: string;

    beforeEach(() => {
      repoDir = join(testDir, 'git-repo');
      execSync(`mkdir -p "${repoDir}"`);
      execSync('git init -b main', { cwd: repoDir });
      execSync('git config user.email "test@example.com"', { cwd: repoDir });
      execSync('git config user.name "Test User"', { cwd: repoDir });

      testFilePath = join(repoDir, 'sample.txt');
      const initialText = [
        'Line 1',
        'Line 2',
        'Line 3',
        'Line 4',
        'Line 5',
        'Line 6',
        'Line 7',
        'Line 8',
      ].join('\n') + '\n';
      writeFileSync(testFilePath, initialText, 'utf8');
      execSync('git add sample.txt', { cwd: repoDir });
      execSync('git commit -m "initial commit"', { cwd: repoDir });
    });

    it('selectively stages and reverts a single hunk via git apply', async () => {
      // Modify line 2 and line 7
      const modifiedText = [
        'Line 1',
        'Line 2 - updated',
        'Line 3',
        'Line 4',
        'Line 5',
        'Line 6',
        'Line 7 - modified',
        'Line 8',
      ].join('\n') + '\n';
      writeFileSync(testFilePath, modifiedText, 'utf8');

      // Get visual diff with hunks
      const diffRes = await service.getVisualDiff(repoDir, 'sample.txt');
      expect(diffRes.ok).toBe(true);
      expect(diffRes.files.length).toBeGreaterThan(0);
      const fileDiff = diffRes.files[0]!;
      expect(fileDiff.hunks.length).toBeGreaterThanOrEqual(1);

      // Take the first hunk and build unified patch
      const hunk = fileDiff.hunks[0]!;
      const patch = buildHunkPatch('sample.txt', hunk);
      expect(patch).toContain('--- a/sample.txt');
      expect(patch).toContain('+++ b/sample.txt');

      // Stage this specific hunk
      const stageRes = await service.stageHunk(repoDir, 'sample.txt', patch);
      expect(stageRes.ok).toBe(true);

      // Check git status: git index should have staged changes for sample.txt
      const statusOut = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' });
      expect(statusOut).toMatch(/^M/);

      // Revert this specific hunk from worktree
      execSync('git reset HEAD', { cwd: repoDir });
      const revertRes = await service.revertHunk(repoDir, 'sample.txt', patch);
      expect(revertRes.ok).toBe(true);
    });
  });
});
