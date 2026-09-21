/**
 * 多源技能自动探测与动态加载管理器 (SkillManager)
 *
 * 自动递归扫描用户主目录及工作区下的技能库：
 * 1. ~/.agents/skills 与 ~/.agents/.skills
 * 2. ~/.codex/skills 与 ~/.codex/superpowers/skills
 * 3. ~/.hap/skills
 * 4. <workspace>/.agents/skills 与 <workspace>/.skills
 *
 * 解析 SKILL.md 中的 YAML Frontmatter 元信息，向智能体注入技能清单，
 * 并支持动态按需激活。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  dirPath: string;
  filePath: string;
  source: 'agents_skills' | 'codex_skills' | 'hap_skills' | 'workspace_skills';
  enabled: boolean;
  updatedAt: string;
}

export class SkillManager {
  private static instance: SkillManager | null = null;
  private cachedSkills: Map<string, DiscoveredSkill> = new Map();
  private lastScanTime = 0;
  private disabledSkills: Set<string> = new Set();

  static getInstance(): SkillManager {
    if (!SkillManager.instance) {
      SkillManager.instance = new SkillManager();
    }
    return SkillManager.instance;
  }

  /** 获取所有候选扫描根目录 */
  private getCandidateRoots(workspace?: string): Array<{ path: string; source: DiscoveredSkill['source'] }> {
    const home = homedir();
    const candidates: Array<{ path: string; source: DiscoveredSkill['source'] }> = [
      { path: join(home, '.agents', 'skills'), source: 'agents_skills' },
      { path: join(home, '.agents', '.skills'), source: 'agents_skills' },
      { path: join(home, '.codex', 'skills'), source: 'codex_skills' },
      { path: join(home, '.codex', 'superpowers', 'skills'), source: 'codex_skills' },
      { path: join(home, '.hap', 'skills'), source: 'hap_skills' },
    ];

    if (workspace && existsSync(workspace)) {
      candidates.unshift(
        { path: join(workspace, '.agents', 'skills'), source: 'workspace_skills' },
        { path: join(workspace, '.skills'), source: 'workspace_skills' },
        { path: join(workspace, '.hap', 'skills'), source: 'workspace_skills' },
      );
    }

    return candidates;
  }

  /** 解析 SKILL.md 内容与 YAML Frontmatter */
  private parseSkillFile(filePath: string, dirPath: string, source: DiscoveredSkill['source']): DiscoveredSkill | null {
    try {
      const content = readFileSync(filePath, 'utf8');
      let name = basename(dirPath);
      let description = '';
      let instructions = content;

      // 匹配 YAML Frontmatter: --- \n name: xxx \n description: yyy \n ---
      const fmMatch = content.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]*([\s\S]*)$/);
      if (fmMatch && fmMatch[1]) {
        const frontmatter = fmMatch[1];
        instructions = (fmMatch[2] || '').trim();

        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        if (nameMatch && nameMatch[1]) {
          name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
        }

        const descMatch = frontmatter.match(/^description:\s*([^\r\n]+(?:[\r\n]+[ \t]+[^\r\n]+)*)/m);
        if (descMatch && descMatch[1]) {
          description = descMatch[1].replace(/\n\s+/g, ' ').trim().replace(/^['"]|['"]$/g, '');
        }
      }

      if (!description) {
        // 从正文中尝试提取首个段落作为描述
        const lines = instructions.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        description = lines[0]?.slice(0, 150) || `技能：${name}`;
      }

      const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      let mtime: Date;
      try {
        mtime = statSync(filePath).mtime;
      } catch {
        mtime = new Date();
      }

      return {
        id,
        name,
        description,
        instructions,
        dirPath,
        filePath,
        source,
        enabled: !this.disabledSkills.has(id),
        updatedAt: mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  /** 递归扫描技能目录（最大探测深度 2） */
  private scanDirectory(dir: string, source: DiscoveredSkill['source'], depth = 0, maxDepth = 2): DiscoveredSkill[] {
    if (depth > maxDepth || !existsSync(dir)) return [];
    let realDir = dir;
    try {
      realDir = realpathSync(dir);
    } catch {
      // ignore
    }

    const results: DiscoveredSkill[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(realDir);
    } catch {
      return [];
    }

    // 检查当前目录下是否直接含有 SKILL.md
    const directSkillMd = join(realDir, 'SKILL.md');
    if (existsSync(directSkillMd)) {
      const parsed = this.parseSkillFile(directSkillMd, realDir, source);
      if (parsed) results.push(parsed);
      return results;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.skills') continue;
      const fullPath = join(realDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const subSkill = join(fullPath, 'SKILL.md');
          if (existsSync(subSkill)) {
            const parsed = this.parseSkillFile(subSkill, fullPath, source);
            if (parsed) results.push(parsed);
          } else {
            // 继续往下探一层
            results.push(...this.scanDirectory(fullPath, source, depth + 1, maxDepth));
          }
        }
      } catch {
        // 忽略坏死软链接等异常
      }
    }

    return results;
  }

  /** 执行全量扫描与更新 */
  discoverSkills(workspace?: string, forceRefresh = false): DiscoveredSkill[] {
    const now = Date.now();
    if (!forceRefresh && this.cachedSkills.size > 0 && now - this.lastScanTime < 30_000) {
      return Array.from(this.cachedSkills.values());
    }

    const roots = this.getCandidateRoots(workspace);
    const discoveredMap = new Map<string, DiscoveredSkill>();

    for (const root of roots) {
      if (!existsSync(root.path)) continue;
      const skills = this.scanDirectory(root.path, root.source);
      for (const skill of skills) {
        // 遵循优先级：前序扫描（workspace 等）优先覆盖全局
        if (!discoveredMap.has(skill.name)) {
          discoveredMap.set(skill.name, skill);
        }
      }
    }

    this.cachedSkills = discoveredMap;
    this.lastScanTime = now;
    return Array.from(this.cachedSkills.values());
  }

  /** 获取所有技能列表 */
  getSkills(workspace?: string): DiscoveredSkill[] {
    return this.discoverSkills(workspace);
  }

  /** 按名称或 ID 获取特定技能 */
  getSkill(nameOrId: string, workspace?: string): DiscoveredSkill | undefined {
    this.discoverSkills(workspace);
    const clean = nameOrId.trim().toLowerCase();
    for (const skill of this.cachedSkills.values()) {
      if (skill.name.toLowerCase() === clean || skill.id === clean) {
        return skill;
      }
    }
    return undefined;
  }

  /** 切换技能启用/禁用状态 */
  toggleSkill(idOrName: string, enabled: boolean): boolean {
    const skill = this.getSkill(idOrName);
    if (!skill) return false;
    skill.enabled = enabled;
    if (enabled) {
      this.disabledSkills.delete(skill.id);
    } else {
      this.disabledSkills.add(skill.id);
    }
    return true;
  }

  /** 别名：设置技能启闭状态 */
  setEnabled(idOrName: string, enabled: boolean): boolean {
    return this.toggleSkill(idOrName, enabled);
  }

  /** 强制重新扫描并刷新缓存 */
  rescan(workspace?: string): DiscoveredSkill[] {
    return this.discoverSkills(workspace, true);
  }

  /** 生成供 System Prompt 使用的可用技能概览 Markdown 文本 */
  buildSkillsPromptSnippet(workspace?: string): string {
    const skills = this.discoverSkills(workspace).filter((s) => s.enabled);
    if (skills.length === 0) return '';

    const lines = [
      '<available_skills>',
      '你可以根据当前任务目标与执行场景，自主参考并按需运用以下可用技能（Skills）。当需要了解某项技能的详细流程规范时，请调用 activate_skill(skill_name: "...") 工具获取完整指导：',
    ];

    for (const s of skills) {
      lines.push(`- **${s.name}**: ${s.description || '专属指导规范'}`);
    }

    lines.push('</available_skills>');
    return lines.join('\n');
  }
}
