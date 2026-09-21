import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SkillManager } from '../src/skills/index.js';
import { activateSkillTool } from '../src/tools/builtin/skill-tool.js';

describe('SkillManager & activate_skill tool', () => {
  it('discovers skills and parses YAML frontmatter from workspace directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
    try {
      const skillsDir = join(tempDir, '.skills', 'code-audit');
      mkdirSync(skillsDir, { recursive: true });

      const skillMd = `---
name: code-audit
description: 全方位代码审计与安全漏洞扫描规则
---
# 代码审计指南
1. 检查 SQL 注入
2. 检查越权访问
`;
      writeFileSync(join(skillsDir, 'SKILL.md'), skillMd, 'utf8');

      const manager = SkillManager.getInstance();
      const discovered = manager.discoverSkills(tempDir, true);

      const auditSkill = discovered.find((s) => s.name === 'code-audit');
      expect(auditSkill).toBeDefined();
      expect(auditSkill?.description).toBe('全方位代码审计与安全漏洞扫描规则');
      expect(auditSkill?.instructions).toContain('检查 SQL 注入');
      expect(auditSkill?.source).toBe('workspace_skills');
      expect(auditSkill?.enabled).toBe(true);

      const snippet = manager.buildSkillsPromptSnippet(tempDir);
      expect(snippet).toContain('<available_skills>');
      expect(snippet).toContain('code-audit');
      expect(snippet).toContain('全方位代码审计与安全漏洞扫描规则');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports toggleSkill / setEnabled and rescan', () => {
    const manager = SkillManager.getInstance();
    const skills = manager.getSkills();
    if (skills.length > 0) {
      const first = skills[0]!;
      expect(manager.setEnabled(first.id, false)).toBe(true);
      expect(manager.getSkill(first.id)?.enabled).toBe(false);

      expect(manager.setEnabled(first.id, true)).toBe(true);
      expect(manager.getSkill(first.id)?.enabled).toBe(true);
    }
  });

  it('executes activate_skill tool successfully', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'skills-tool-test-'));
    try {
      const skillsDir = join(tempDir, '.skills', 'test-helper');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, 'SKILL.md'),
        `---
name: test-helper
description: 单元测试生成器
---
请编写高质量 Vitest 测试用例。`,
        'utf8',
      );

      const manager = SkillManager.getInstance();
      manager.discoverSkills(tempDir, true);

      const result = await activateSkillTool.run(
        { skill_name: 'test-helper' },
        {
          agent: {
            id: 'tester',
            name: 'Tester',
            description: '',
            systemPrompt: '',
            model: { primary: 'test', fallbacks: [] },
            tools: { allow: ['*'], deny: [] },
            workspace: tempDir,
            limits: { dailyTokenBudget: 0 },
            telemetry: { logInputs: false, logOutputs: false, tracesPerDay: 0 },
          },
          taskId: 'test-task',
          signal: new AbortController().signal,
          depth: 0,
        } as any,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain('已成功激活技能');
      expect(result.content).toContain('test-helper');
      expect(result.content).toContain('请编写高质量 Vitest 测试用例');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
