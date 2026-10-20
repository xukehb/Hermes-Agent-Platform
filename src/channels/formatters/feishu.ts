/**
 * 飞书 (Feishu / Lark) 策略格式化器。
 */

import { BaseChannelFormatter } from './base.js';
import { AGENT_PATTERNS } from './patterns.js';
import type { PlaceholderManager } from './placeholder.js';
import type { FormatterOptions } from './types.js';

export interface FeishuCardContent {
  config: { wide_screen_mode: boolean };
  header: {
    template: string;
    title: { tag: 'plain_text'; content: string };
  };
  elements: Array<Record<string, unknown>>;
}

export class FeishuFormatter extends BaseChannelFormatter {
  readonly channel = 'feishu' as const;

  protected override formatThinking(content: string, pm: PlaceholderManager, options?: FormatterOptions): string {
    if (options?.showThinking === false) {
      return content.replace(AGENT_PATTERNS.thinking, '');
    }
    return content.replace(AGENT_PATTERNS.thinking, (_match, thinking) => {
      const trimmed = thinking.trim();
      if (trimmed.length === 0) return '';
      const quoteLines = trimmed.split('\n').map((l: string) => `> ${l}`).join('\n');
      return '\n' + pm.wrap(`> 💭 **思考过程**\n${quoteLines}`) + '\n';
    });
  }

  protected override formatStatusIndicators(content: string): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.progressHeader, '⚙️ **$1**');
    result = result.replace(AGENT_PATTERNS.toolStart, '⏳ **`$1`**$2');
    result = result.replace(AGENT_PATTERNS.toolSuccess, (_match, tool, args, dur) => {
      const durationPart = dur ? ` <font color='grey'>${dur.trim()}</font>` : '';
      return `✅ **\`$tool\`**${args ?? ''}${durationPart}`;
    });
    result = result.replace(AGENT_PATTERNS.toolError, '❌ <font color=\'red\'>**`$1`**</font>$2');
    result = result.replace(AGENT_PATTERNS.modelSwitch, '↻ `$1` ➔ `$2`$3');
    result = result.replace(AGENT_PATTERNS.terminalNote, (_match, model, tokens, taskId) => {
      return `<font color='grey'>🤖 ${model}  •  📊 ${tokens} tokens  •  🆔 ${taskId}</font>`;
    });
    return result;
  }
}

export function buildFeishuCard(text: string, formatter?: FeishuFormatter): FeishuCardContent {
  let template = 'turquoise';
  let title = 'HAP 智能体协同回执';

  const isError = /✗|❌|失败|CONTROL_FORBIDDEN|异常/i.test(text);
  const isProgress = /⚙|正在处理|⏳/.test(text);
  const isHelpOrCommand = /【项目与工作区】|开发者远程协同指令|\/help/.test(text);

  if (isError) {
    template = 'red';
    title = '❌ 智能体执行异常';
  } else if (isProgress) {
    template = 'indigo';
    title = '⚙️ 智能体处理中';
  } else if (isHelpOrCommand) {
    template = 'wathet';
    title = '📋 开发者协同指令';
  } else {
    template = 'turquoise';
    title = '✅ 智能体协同回执';
  }

  const activeFormatter = formatter ?? new FeishuFormatter();
  const formattedMarkdown = activeFormatter.format(text);

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'markdown',
        content: formattedMarkdown,
      },
      {
        tag: 'hr',
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `Hermes Agent Platform · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          },
        ],
      },
    ],
  };
}

export interface FeishuActionOption {
  text: string;
  type?: 'primary' | 'danger' | 'default';
  value: Record<string, unknown> | string;
}

/**
 * 构造飞书交互式卡片（支持按钮操作与回调回写）。
 */
export function buildFeishuInteractiveCard(
  title: string,
  contentMarkdown: string,
  actions: FeishuActionOption[],
  options?: { template?: string; note?: string },
): FeishuCardContent {
  const template = options?.template ?? 'turquoise';
  const actionButtons = actions.map((act) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: act.text },
    type: act.type ?? 'default',
    value: typeof act.value === 'string' ? { action: act.value } : act.value,
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'markdown',
        content: contentMarkdown,
      },
      {
        tag: 'action',
        actions: actionButtons,
      },
      {
        tag: 'hr',
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: options?.note ?? `Hermes Agent Platform · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          },
        ],
      },
    ],
  };
}

/**
 * 构造飞书高危操作专属审批卡片。
 */
export function buildFeishuApprovalCard(approval: {
  id: string;
  agent: string;
  action: string;
  reason?: string | undefined;
}): FeishuCardContent {
  const content = [
    `🛡️ **智能体高危操作审批请求**`,
    `• **执行智能体**: \`${approval.agent}\``,
    `• **申请执行操作**: \`${approval.action}\``,
    approval.reason ? `• **操作原因**: ${approval.reason}` : '',
    '',
    '> 请在限定时间内审批是否允许执行：',
  ].filter(Boolean).join('\n');

  return buildFeishuInteractiveCard(
    '🛡️ 智能体操作审批请求',
    content,
    [
      {
        text: '🟢 批准执行',
        type: 'primary',
        value: { approvalId: approval.id, decision: 'approve' },
      },
      {
        text: '🔴 拒绝拦截',
        type: 'danger',
        value: { approvalId: approval.id, decision: 'reject' },
      },
    ],
    { template: 'orange' },
  );
}
