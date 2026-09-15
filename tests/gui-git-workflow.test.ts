import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('better-sqlite3', () => {
  return {
    default: class MockDatabase {
      pragma() {}
      exec() {}
      prepare() {
        return {
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
          get: () => undefined,
          all: () => [],
        };
      }
    },
  };
});

import { GuiService } from '../src/gui/service.js';

describe('GuiService Git Branch, Merge, Rebase & Auth Workflow', () => {
  let testDir: string;
  let configPath: string;
  let repoDir: string;
  let service: GuiService;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    testDir = mkdtempSync(join(tmpdir(), 'hap-git-test-'));
    process.env.HOME = testDir;
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

    repoDir = join(testDir, 'git-repo');
    execSync(`mkdir -p "${repoDir}"`);
    execSync('git init -b main', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
    execSync('git config user.name "Test User"', { cwd: repoDir });

    writeFileSync(join(repoDir, 'README.md'), '# Initial Repository\n', 'utf8');
    execSync('git add README.md', { cwd: repoDir });
    execSync('git commit -m "chore: initial commit"', { cwd: repoDir });

    service = new GuiService(configPath);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('gitListBranches & gitCheckoutBranch', () => {
    it('lists branches correctly and identifies current branch', async () => {
      const res = await service.gitListBranches(repoDir);
      expect(res.ok).toBe(true);
      expect(res.currentBranch).toBe('main');
      expect(res.localBranches.some((b) => b.name === 'main' && b.isCurrent)).toBe(true);
      expect(res.isMerging).toBe(false);
      expect(res.isRebasing).toBe(false);
    });

    it('creates and switches to a new branch', async () => {
      const checkoutRes = await service.gitCheckoutBranch(repoDir, 'feature/new-button', true);
      expect(checkoutRes.ok).toBe(true);
      expect(checkoutRes.currentBranch).toBe('feature/new-button');

      const listRes = await service.gitListBranches(repoDir);
      expect(listRes.currentBranch).toBe('feature/new-button');
      expect(listRes.localBranches.some((b) => b.name === 'feature/new-button' && b.isCurrent)).toBe(true);
      expect(listRes.localBranches.some((b) => b.name === 'main' && !b.isCurrent)).toBe(true);
    });

    it('switches back to an existing branch', async () => {
      await service.gitCheckoutBranch(repoDir, 'feature/test-b', true);
      const backRes = await service.gitCheckoutBranch(repoDir, 'main', false);
      expect(backRes.ok).toBe(true);
      expect(backRes.currentBranch).toBe('main');
    });
  });

  describe('gitMergeBranch & gitMergeAbort', () => {
    it('merges a clean branch without conflict', async () => {
      // Create feature branch and make a commit
      await service.gitCheckoutBranch(repoDir, 'feature/clean', true);
      writeFileSync(join(repoDir, 'clean.txt'), 'clean content\n', 'utf8');
      execSync('git add clean.txt', { cwd: repoDir });
      execSync('git commit -m "feat: add clean.txt"', { cwd: repoDir });

      // Switch back to main and merge feature/clean
      await service.gitCheckoutBranch(repoDir, 'main', false);
      const mergeRes = await service.gitMergeBranch(repoDir, 'feature/clean');
      expect(mergeRes.ok).toBe(true);
      expect(mergeRes.hasConflict).toBe(false);
    });

    it('detects conflict and allows merge abort', async () => {
      // Create feature branch that modifies README.md
      await service.gitCheckoutBranch(repoDir, 'feature/conflict', true);
      writeFileSync(join(repoDir, 'README.md'), '# Conflict on branch\n', 'utf8');
      execSync('git add README.md', { cwd: repoDir });
      execSync('git commit -m "feat: branch edit"', { cwd: repoDir });

      // Main also modifies README.md differently
      await service.gitCheckoutBranch(repoDir, 'main', false);
      writeFileSync(join(repoDir, 'README.md'), '# Conflict on main\n', 'utf8');
      execSync('git add README.md', { cwd: repoDir });
      execSync('git commit -m "chore: main edit"', { cwd: repoDir });

      // Merge feature/conflict into main -> should conflict
      const mergeRes = await service.gitMergeBranch(repoDir, 'feature/conflict');
      expect(mergeRes.ok).toBe(false);
      expect(mergeRes.hasConflict).toBe(true);

      // Check git status detects isMerging
      const statusRes = await service.getGitStatus(repoDir);
      expect(statusRes.isMerging).toBe(true);

      // Abort merge
      const abortRes = await service.gitMergeAbort(repoDir);
      expect(abortRes.ok).toBe(true);

      // Verify no longer merging
      const postAbortStatus = await service.getGitStatus(repoDir);
      expect(postAbortStatus.isMerging).toBe(false);
    });
  });

  describe('gitRebaseBranch & gitRebaseAbort', () => {
    it('rebases a branch cleanly onto main', async () => {
      // Branch from main
      await service.gitCheckoutBranch(repoDir, 'feature/rebase-me', true);
      writeFileSync(join(repoDir, 'feature.txt'), 'feature content\n', 'utf8');
      execSync('git add feature.txt', { cwd: repoDir });
      execSync('git commit -m "feat: add feature.txt"', { cwd: repoDir });

      // Main adds non-conflicting file
      await service.gitCheckoutBranch(repoDir, 'main', false);
      writeFileSync(join(repoDir, 'main.txt'), 'main content\n', 'utf8');
      execSync('git add main.txt', { cwd: repoDir });
      execSync('git commit -m "feat: add main.txt"', { cwd: repoDir });

      // Switch to feature/rebase-me and rebase onto main
      await service.gitCheckoutBranch(repoDir, 'feature/rebase-me', false);
      const rebaseRes = await service.gitRebaseBranch(repoDir, 'main');
      expect(rebaseRes.ok).toBe(true);
      expect(rebaseRes.hasConflict).toBe(false);
    });

    it('detects rebase conflict and allows abort', async () => {
      // Branch from main
      await service.gitCheckoutBranch(repoDir, 'feature/rebase-conflict', true);
      writeFileSync(join(repoDir, 'README.md'), '# Rebase branch conflict\n', 'utf8');
      execSync('git add README.md', { cwd: repoDir });
      execSync('git commit -m "feat: rebase branch change"', { cwd: repoDir });

      // Main changes README.md
      await service.gitCheckoutBranch(repoDir, 'main', false);
      writeFileSync(join(repoDir, 'README.md'), '# Rebase main change\n', 'utf8');
      execSync('git add README.md', { cwd: repoDir });
      execSync('git commit -m "feat: main conflict change"', { cwd: repoDir });

      // Switch to feature and rebase onto main
      await service.gitCheckoutBranch(repoDir, 'feature/rebase-conflict', false);
      const rebaseRes = await service.gitRebaseBranch(repoDir, 'main');
      expect(rebaseRes.ok).toBe(false);
      expect(rebaseRes.hasConflict).toBe(true);

      // Check status detects isRebasing
      const statusRes = await service.getGitStatus(repoDir);
      expect(statusRes.isRebasing).toBe(true);

      // Abort rebase
      const abortRes = await service.gitRebaseAbort(repoDir);
      expect(abortRes.ok).toBe(true);

      // Verify no longer rebasing
      const postAbortStatus = await service.getGitStatus(repoDir);
      expect(postAbortStatus.isRebasing).toBe(false);
    });
  });

  describe('Git Remote Authentication Info & Configuration', () => {
    it('returns git auth info including remote URL and SSH public key availability', async () => {
      // Add a mock origin remote
      execSync('git remote add origin https://github.com/example-user/example-repo.git', { cwd: repoDir });

      const authInfo = await service.getGitAuthInfo(repoDir);
      expect(authInfo.remoteUrl).toBe('https://github.com/example-user/example-repo.git');
      expect(authInfo.isSsh).toBe(false);
      expect(typeof authInfo.hasSshKey).toBe('boolean');
    });

    it('configures SSH remote URL on a repository', async () => {
      execSync('git remote add origin https://github.com/example-user/example-repo.git', { cwd: repoDir });

      const configRes = await service.configureGitSsh(repoDir);
      expect(configRes.ok).toBe(true);
      expect(configRes.remoteUrl).toBe('git@github.com:example-user/example-repo.git');

      const updatedInfo = await service.getGitAuthInfo(repoDir);
      expect(updatedInfo.remoteUrl).toBe('git@github.com:example-user/example-repo.git');
      expect(updatedInfo.isSsh).toBe(true);
    });

    it('configures Personal Access Token on a repository', async () => {
      execSync('git remote add origin https://github.com/example-user/example-repo.git', { cwd: repoDir });

      const tokenRes = await service.configureGitToken(
        repoDir,
        'example-user',
        'ghp_mockAccessToken1234567890abcdef'
      );
      expect(tokenRes.ok).toBe(true);
      expect(tokenRes.message).toContain('凭据已成功保存');
    });
  });

  describe('Git Stash Commit, Commit History & Rollback Workflow', () => {
    it('creates a stash commit with [暂存] prefix and updates git status', async () => {
      // Create some uncommitted changes
      writeFileSync(join(repoDir, 'feature.txt'), 'console.log("stash me");\n', 'utf8');
      writeFileSync(join(repoDir, 'README.md'), '# Updated Readme\n', 'utf8');

      const preStatus = await service.getGitStatus(repoDir);
      expect(preStatus.uncommittedCount).toBe(2);

      // Execute gitStashCommit with custom note
      const stashRes = await service.gitStashCommit(repoDir, '临时保存功能开发进度');
      expect(stashRes.ok).toBe(true);
      expect(stashRes.isStash).toBe(true);
      expect(stashRes.hash).toBeDefined();

      // Working tree should now be clean
      const postStatus = await service.getGitStatus(repoDir);
      expect(postStatus.uncommittedCount).toBe(0);
      expect(postStatus.isLatestStash).toBe(true);
      expect(postStatus.latestCommit?.message).toContain('[暂存]');
      expect(postStatus.latestCommit?.message).toContain('临时保存功能开发进度');
    });

    it('rejects gitStashCommit if working tree is clean', async () => {
      await expect(service.gitStashCommit(repoDir)).rejects.toThrow('当前工作区无任何未提交的修改，无需暂存');
    });

    it('retrieves commit history and properly flags stash commits', async () => {
      // Make a normal commit
      writeFileSync(join(repoDir, 'file1.txt'), 'normal', 'utf8');
      await service.gitCommit(repoDir, 'feat: normal feature');

      // Make a stash commit
      writeFileSync(join(repoDir, 'file2.txt'), 'stash content', 'utf8');
      await service.gitStashCommit(repoDir);

      const historyRes = await service.gitGetCommitHistory(repoDir, 10);
      expect(historyRes.ok).toBe(true);
      expect(historyRes.commits.length).toBeGreaterThanOrEqual(3);

      const topCommit = historyRes.commits[0];
      expect(topCommit).toBeDefined();
      if (!topCommit) throw new Error('topCommit undefined');
      expect(topCommit.isStash).toBe(true);
      expect(topCommit.message).toContain('[暂存]');
      expect(topCommit.shortHash.length).toBe(7);

      const secondCommit = historyRes.commits[1];
      expect(secondCommit).toBeDefined();
      if (!secondCommit) throw new Error('secondCommit undefined');
      expect(secondCommit.isStash).toBe(false);
      expect(secondCommit.message).toContain('feat: normal feature');
    });

    it('rolls back a stash commit back into workspace uncommitted changes (mixed reset)', async () => {
      // Modify file and stash it
      writeFileSync(join(repoDir, 'revert-target.txt'), 'important work in progress\n', 'utf8');
      await service.gitStashCommit(repoDir, '快照：半成品代码');

      let status = await service.getGitStatus(repoDir);
      expect(status.uncommittedCount).toBe(0);

      // Rollback the latest commit to workspace
      const rollbackRes = await service.gitRollbackCommit(repoDir, undefined, 'mixed');
      expect(rollbackRes.ok).toBe(true);
      expect(rollbackRes.message).toContain('回滚并保留所有修改到工作区');

      // Working tree should now have the uncommitted changes back!
      status = await service.getGitStatus(repoDir);
      expect(status.uncommittedCount).toBeGreaterThanOrEqual(1);
      expect(status.changedFiles.some((f) => f.file === 'revert-target.txt')).toBe(true);
    });

    it('shows commit diff and allows git revert', async () => {
      writeFileSync(join(repoDir, 'diff-test.txt'), 'hello world diff\n', 'utf8');
      const commitRes = await service.gitCommit(repoDir, 'feat: add diff test');
      expect(commitRes.ok).toBe(true);

      const history = await service.gitGetCommitHistory(repoDir, 1);
      const topHistory = history.commits[0];
      if (!topHistory) throw new Error('topHistory undefined');
      const hash = topHistory.hash;

      // Show commit diff
      const showRes = await service.gitShowCommit(repoDir, hash);
      expect(showRes.ok).toBe(true);
      expect(showRes.diff).toContain('hello world diff');

      // Revert commit
      const revertRes = await service.gitRevertCommit(repoDir, hash);
      expect(revertRes.ok).toBe(true);

      const postRevertHistory = await service.gitGetCommitHistory(repoDir, 1);
      const latestRevert = postRevertHistory.commits[0];
      if (!latestRevert) throw new Error('latestRevert undefined');
      expect(latestRevert.message).toContain('Revert "feat: add diff test"');
    });
  });

  describe('Git Staging Area (Stage +, Unstage - & Revert)', () => {
    it('stages a file with stageFileDiff (+) and unstages with unstageFileDiff (-)', async () => {
      writeFileSync(join(repoDir, 'verification.md'), '# Verification doc\n', 'utf8');
      writeFileSync(join(repoDir, 'docker-compose.yml'), 'version: "3"\n', 'utf8');

      let status = await service.getGitStatus(repoDir);
      expect(status.unstagedCount).toBe(2);
      expect(status.stagedCount).toBe(0);

      // Click + to stage verification.md
      const stageRes = await service.stageFileDiff(repoDir, 'verification.md');
      expect(stageRes.ok).toBe(true);

      status = await service.getGitStatus(repoDir);
      expect(status.stagedCount).toBe(1);
      expect(status.stagedFiles?.some((f) => f.file === 'verification.md')).toBe(true);
      expect(status.unstagedCount).toBe(1);
      expect(status.unstagedFiles?.some((f) => f.file === 'docker-compose.yml')).toBe(true);

      // Click - to unstage verification.md
      const unstageRes = await service.unstageFileDiff(repoDir, 'verification.md');
      expect(unstageRes.ok).toBe(true);

      status = await service.getGitStatus(repoDir);
      expect(status.stagedCount).toBe(0);
      expect(status.unstagedCount).toBe(2);
    });

    it('commits only staged files when staged files exist', async () => {
      writeFileSync(join(repoDir, 'staged-file.txt'), 'staged content\n', 'utf8');
      writeFileSync(join(repoDir, 'unstaged-file.txt'), 'unstaged content\n', 'utf8');

      // Stage only staged-file.txt
      await service.stageFileDiff(repoDir, 'staged-file.txt');

      // Commit
      const commitRes = await service.gitCommit(repoDir, 'feat: only commit staged file');
      expect(commitRes.ok).toBe(true);

      // Verify staged-file is committed, while unstaged-file remains unstaged in working tree!
      const status = await service.getGitStatus(repoDir);
      expect(status.stagedCount).toBe(0);
      expect(status.unstagedCount).toBe(1);
      expect(status.unstagedFiles?.some((f) => f.file === 'unstaged-file.txt')).toBe(true);
    });

    it('reverts file modifications using revertFileDiff', async () => {
      writeFileSync(join(repoDir, 'README.md'), '# Completely Modified\n', 'utf8');
      let status = await service.getGitStatus(repoDir);
      expect(status.unstagedFiles?.some((f) => f.file === 'README.md')).toBe(true);

      const revertRes = await service.revertFileDiff(repoDir, 'README.md');
      expect(revertRes.ok).toBe(true);

      status = await service.getGitStatus(repoDir);
      expect(status.unstagedFiles?.some((f) => f.file === 'README.md')).toBe(false);
    });
  });
});
