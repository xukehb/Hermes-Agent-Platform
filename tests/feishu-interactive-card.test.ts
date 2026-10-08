import { describe, expect, it } from 'vitest';
import {
  buildFeishuCard,
  buildFeishuInteractiveCard,
  buildFeishuApprovalCard,
} from '../src/channels/formatters/feishu.js';

describe('飞书交互卡片与审批流 (Feishu Interactive Cards)', () => {
  it('buildFeishuCard 生成标准卡片', () => {
    const card = buildFeishuCard('任务已完成');
    expect(card.header.title.content).toContain('智能体协同回执');
    expect(card.elements.length).toBeGreaterThanOrEqual(2);
  });

  it('buildFeishuInteractiveCard 生成包含操作按钮的卡片', () => {
    const card = buildFeishuInteractiveCard(
      '部署审批',
      '请确认是否部署到生产环境：',
      [
        { text: '同意部署', type: 'primary', value: { op: 'deploy' } },
        { text: '取消', type: 'danger', value: { op: 'cancel' } },
      ],
      { template: 'blue' },
    );

    expect(card.header.title.content).toBe('部署审批');
    expect(card.header.template).toBe('blue');

    const actionElem = card.elements.find((el) => el.tag === 'action') as any;
    expect(actionElem).toBeDefined();
    expect(actionElem.actions).toHaveLength(2);
    expect(actionElem.actions[0].text.content).toBe('同意部署');
    expect(actionElem.actions[0].type).toBe('primary');
    expect(actionElem.actions[1].text.content).toBe('取消');
    expect(actionElem.actions[1].type).toBe('danger');
  });

  it('buildFeishuApprovalCard 生成高危操作审批专用卡片', () => {
    const card = buildFeishuApprovalCard({
      id: 'appr-999',
      agent: 'ops-agent',
      action: 'rm -rf /var/log/temp',
      reason: '清理临时日志',
    });

    expect(card.header.title.content).toContain('审批请求');
    expect(card.header.template).toBe('orange');

    const actionElem = card.elements.find((el) => el.tag === 'action') as any;
    expect(actionElem).toBeDefined();
    expect(actionElem.actions).toHaveLength(2);

    const approveBtn = actionElem.actions[0];
    expect(approveBtn.text.content).toContain('批准执行');
    expect(approveBtn.value).toEqual({ approvalId: 'appr-999', decision: 'approve' });

    const rejectBtn = actionElem.actions[1];
    expect(rejectBtn.text.content).toContain('拒绝拦截');
    expect(rejectBtn.value).toEqual({ approvalId: 'appr-999', decision: 'reject' });
  });
});
