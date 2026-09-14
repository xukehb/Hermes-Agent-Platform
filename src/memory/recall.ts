import { MemoryStore } from './store.js';

export async function recallRelevantMemories(prompt: string, workspace?: string, agentId?: string): Promise<string> {
  const store = MemoryStore.getInstance();
  const results = await store.searchMemories({
    text: prompt,
    workspace,
    agentId,
    limit: 3,
    threshold: 0.25,
  });

  if (results.length === 0) {
    return '';
  }

  const lines: string[] = [
    '## 💡 智能体跨会话长期记忆与偏好规范 (Recalled Knowledge & Preferences)',
    '以下是从历史任务与用户偏好库中检索出的高相关上下文，请在生成代码或回答时严格遵守：',
  ];

  let totalLength = lines.join('\n').length;
  for (const res of results) {
    const card = res.memory;
    const catLabels: Record<string, string> = {
      preference: '用户习惯',
      fact: '领域事实',
      case: '既往案例',
      architecture: '架构约定',
      convention: '代码规范',
      domain: '业务背景',
      custom: '自定义知识',
    };
    const catLabel = catLabels[card.category] || card.category;

    lines.push(`- **[${catLabel}] ${card.title}** (相关度: ${(res.score * 100).toFixed(0)}%)`);
    const content = card.content.replace(/\n/g, '\n  ');
    if (totalLength + content.length > 4000) break;
    lines.push(`  ${content}`);
    totalLength += content.length;
  }

  return lines.join('\n') + '\n\n';
}
