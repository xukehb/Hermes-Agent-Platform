/**
 * 智能体系统提示组装（FR-AGT-007）。
 *
 * 完整 system 消息由三段拼接：身份段（谁）、职责段（做什么）、环境段（在哪做）。
 * 协议段与工具清单段不在这里拼——那是各协议适配器的职责（hermes-native 注入
 * <tools> 块，openai-tools 走请求体 tools 字段），在此拼死会让换协议时提示词错乱。
 *
 * 职责段来自 system_prompt_file；文件缺失时降级为 description，并在提示里留一行说明，
 * 避免「配了文件但路径写错」表现为模型行为莫名退化而无从察觉。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { readFileSync } from 'node:fs';
import type { ResolvedAgent } from '../config/index.js';

/** 组装参数。缺省时取当前时间与 agent.workspace。 */
export interface SystemPromptOptions {
  /** 覆盖当前时间，测试用 */
  now?: Date;
  /** 追加的环境说明，如通道信息 */
  extra?: string;
  /** 可派生的子智能体清单（含描述），用于让父智能体知道能找谁 */
  subagents?: ReadonlyArray<{ id: string; description: string }>;
  /** 是否处于目标驱动模式（Goal Mode） */
  goalMode?: boolean;
  /** 是否处于规划模式（Plan Mode） */
  planMode?: boolean;
  /** 动态发现并可用的技能清单 Prompt 文本 */
  skillsSnippet?: string;
}

/** 读取职责段。返回 undefined 表示未配置或读取失败。 */
function readDutyFile(file: string | undefined): { text: string } | { error: string } | undefined {
  if (file === undefined) return undefined;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (raw === '') return { error: '职责提示文件 ' + file + ' 为空' };
    return { text: raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: '职责提示文件 ' + file + ' 读取失败：' + message };
  }
}

/** 身份段：让模型知道自己是谁、以什么口吻回应。 */
function identitySection(agent: ResolvedAgent): string {
  const lines = [
    '你是 ' + agent.identity.displayName + '（智能体 id：' + agent.id + '）。',
  ];
  if (agent.description.trim() !== '') lines.push('岗位职责：' + agent.description.trim());
  if (agent.capabilities.length > 0) lines.push('能力标签：' + agent.capabilities.join('、'));
  return lines.join('\n');
}

/** 环境段：工作目录、语言约定、工具使用纪律。 */
function environmentSection(agent: ResolvedAgent, now: Date): string {
  const lines = [
    '当前时间：' + now.toISOString(),
    '文件工作目录：' + agent.workspace + '（文件类与命令类工具的相对路径都从这里解析）',
    '回复语言：与用户使用的语言保持一致；用户使用中文时用中文回复。',
    '系统能力与最高权限：用户已为你完全开放了本机的最高系统执行权限（包括 open_external、shell、write_file、apply_patch、read_file、http_fetch 等）。当用户要求在浏览器中打开网页、运行本地命令、启动程序或读写修改文件时，你拥有直接执行的完全权限，请立即调用相应工具执行，绝对不要声称自己没有权限。',
    '工具纪律：需要读写文件、执行命令或检索资料时调用工具，不要凭猜测编造文件内容或命令输出。',
    '工具执行结果会以工具消息回灌给你；若结果为错误，请阅读错误信息并修正参数后重试，不要重复同一个失败调用。',
  ];
  return lines.join('\n');
}

/** 子智能体段：仅在允许派生时出现。 */
function subagentSection(options: SystemPromptOptions): string | undefined {
  const list = options.subagents ?? [];
  if (list.length === 0) return undefined;
  const lines = ['你可以通过 spawn_subagent 工具把子任务派给以下智能体：'];
  for (const item of list) {
    lines.push('- ' + item.id + (item.description.trim() === '' ? '' : '：' + item.description.trim()));
  }
  lines.push('派生前先自行判断该子任务是否确实超出你的职责范围；能自己做完的不要派生。');
  return lines.join('\n');
}

/** 人设与沟通风格段：消除机械 AI 客套感，塑造专业、自然、有主见的资深协作者口吻。 */
function conversationalPersonaSection(): string {
  const lines = [
    '沟通风格与交互准则：',
    '1. 拒绝机械套话：严禁以「好的，收到」、「明白您的需求」、「作为一名 AI」、「希望以上回答对您有所帮助」等死板客服模板开头或结尾。',
    '2. 资深专业与平视沟通：以资深工程师或得力合伙人的同侪口吻交流，简明、自信、有判断力。就事论事，直击要害。',
    '3. 有效推进而非推卸：若信息不明确，基于合理技术推断先给出推荐方案并顺带求证，切忌机械反问「你这条消息信息不完整」或让用户做问卷。',
    '4. 自然内化记忆：当有长期记忆或背景知识上下文时，将其视为你与生俱来的背景认知自然运用，严禁刻意提及「根据记忆库」等生硬字眼。',
  ];
  return lines.join('\n');
}

/** 目标模式引导段：引导自主规划、拆解里程碑、工具闭环推进与自适应纠偏。 */
function goalModeSection(): string {
  const lines = [
    '🎯 当前处于【目标模式】（Goal Mode / 自主长任务达成模式）：',
    '1. 目标导向与自主规划：用户的输入是一个高层目标。必须以达成该目标为唯一评判标准，不要仅凭一问一答草率停下。',
    '2. 里程碑拆解与追踪：任务启动后，首选调用 goal_tracker(action: "init_plan", ...) 将总目标分解为 2~5 个具体、可验证的里程碑（如：环境侦测与定位、方案实施、综合验证与验收）。在每一步取得成果后，必须调用 goal_tracker(action: "update_milestone", ...) 推进状态。',
    '3. 动手执行与闭环验证：积极利用可用工具（浏览器操控 browser_*、桌面操控 desktop_*、代码与系统命令 shell、文件操作等）开展真实操作，绝不要在未经实际验证前主观宣称任务完成。',
    '4. 自适应纠错：遇到工具调用报错或测试失败时，自行分析根因并调整方案继续尝试，绝不要直接放弃或无谓地将错误反抛给用户。',
    '5. 交付总结：当且仅当全部里程碑均达成并经过验证后，调用 goal_tracker(action: "complete_goal", ...) 并向用户输出结构化交付报告。',
  ];
  return lines.join('\n');
}

/** 规划模式引导段：引导只读深入调研、生成方案、等待审批。 */
function planModeSection(): string {
  const lines = [
    '📋 当前处于【规划模式】（Plan Mode / 调研与方案规划模式）：',
    '1. 只读探索纪律：当前阶段严禁对代码库或工作区做任何修改。严禁调用 write_file、apply_patch、或具有破坏性/修改性质的 shell 命令。',
    '2. 深度调研：充分调用只读工具（read_file、search、list_dir、web_search 等）全面阅读与理解上下文、依赖关系、架构影响。',
    '3. 结构化输出实施方案：必须向用户产出详尽的 Markdown 实施方案，包含：',
    '   - 🎯 目标与问题背景分析',
    '   - ⚠️ 需用户审阅与决策的关键技术选型或疑问（Open Questions）',
    '   - 📝 涉及修改的文件清单（以 [NEW]、[MODIFY]、[DELETE] 明确标出）及具体改动思路',
    '   - 🧪 自动化测试与手动验证方案',
    '4. 等待审批：生成方案后明确停下并提示用户「请审阅上述方案，确认批准后我将开始实施」。',
  ];
  return lines.join('\n');
}

/** 组装完整 system 提示正文。 */
export function composeSystemPrompt(agent: ResolvedAgent, options: SystemPromptOptions = {}): string {
  const now = options.now ?? new Date();
  const sections: string[] = [identitySection(agent)];

  const duty = readDutyFile(agent.systemPromptFile);
  if (duty !== undefined) {
    if ('text' in duty) sections.push(duty.text);
    else sections.push('（注意：' + duty.error + '，本轮按岗位职责描述行事。）');
  }

  const subagents = subagentSection(options);
  if (subagents !== undefined) sections.push(subagents);

  sections.push(environmentSection(agent, now));
  if (options.goalMode) {
    sections.push(goalModeSection());
  }
  if (options.planMode) {
    sections.push(planModeSection());
  }
  if (options.skillsSnippet) {
    sections.push(options.skillsSnippet);
  }
  sections.push(conversationalPersonaSection());
  if (options.extra !== undefined && options.extra.trim() !== '') sections.push(options.extra.trim());

  return sections.join('\n\n');
}

/** 摘要压缩用的提示词（FR-LOOP-013），由 utility_model 执行。 */
export const COMPACT_SYSTEM_PROMPT = [
  '你是对话历史压缩器。把给定的多轮对话压缩成一段结构化摘要，供后续轮次继续使用。',
  '必须保留：用户的原始目标与全部硬性约束、已确认的事实与结论、已完成的关键操作及其结果、',
  '尚未完成的待办事项、以及后续步骤依赖的具体标识（文件路径、命令、id、数值）。',
  '必须丢弃：寒暄、重复表述、已被更新覆盖的中间结论、逐字的长篇工具输出（改写为一行结果描述）。',
  '直接输出摘要正文，不要加前言、不要用「以下是摘要」之类的引导语，不要调用任何工具。',
].join('\n');

/** 标题生成提示词（FR-TASK-002 的任务卡片需要标题），同样走 utility_model。 */
export const TITLE_SYSTEM_PROMPT = [
  '你是任务标题生成器。根据用户指令生成一个不超过 24 个字的中文短标题，概括任务目标。',
  '只输出标题本身，不要引号、不要标点结尾、不要任何解释。',
].join('\n');
