/**
 * 技能激活与阅读工具 (activate_skill / read_skill)
 *
 * 允许智能体在任务执行中按需调阅某项专业技能的完整流程指引规范。
 */

import { z } from 'zod';
import { defineTool } from '../define.js';
import { SkillManager } from '../../skills/skill-manager.js';

export const activateSkillSchema = z.object({
  skill_name: z.string().min(1).describe('要调阅或激活的技能名称或 ID（如 systematic-debugging, test-driven-development, writing-plans 等）'),
});

export const activateSkillTool = defineTool({
  name: 'activate_skill',
  description: '读取并激活特定的专业技能（Skill），获取该技能的完整指引流程、执行法则、参考样例与最佳实践。在遇到对应领域的复杂任务前调用本工具。',
  schema: activateSkillSchema,
  run: async (args, ctx) => {
    const manager = SkillManager.getInstance();
    const workspace = ctx.agent.workspace || process.cwd();
    const skill = manager.getSkill(args.skill_name, workspace);

    if (!skill) {
      const allSkills = manager.getSkills(workspace).map((s) => s.name);
      return {
        content: `未找到名称或 ID 为 "${args.skill_name}" 的技能。\n当前可用技能列表:\n${allSkills.map((n) => `· ${n}`).join('\n') || '（未安装技能）'}`,
        isError: true,
      };
    }

    return {
      content: `🧩 已成功激活技能【${skill.name}】！\n- 来源: ${skill.filePath}\n- 描述: ${skill.description}\n\n---\n\n${skill.instructions}`,
      isError: false,
    };
  },
});
