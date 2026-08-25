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
