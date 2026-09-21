import { MemoryStore, isCleanMemoryCandidate } from './store.js';

export async function recallRelevantMemories(prompt: string, workspace?: string, agentId?: string): Promise<string> {
  const store = MemoryStore.getInstance();
  const results = await store.searchMemories({
    text: prompt,
    workspace,
    agentId,
    limit: 3,
    threshold: 0.25,
  });

  const cleanResults = results.filter((res) => isCleanMemoryCandidate(res.memory.content));
  if (cleanResults.length === 0) {
    return '';
  }

  const lines: string[] = [
    '## 🧠 背景知识与用户长期记忆 (Context & Working Memory)',
    '以下为你沉淀的历史事实与长期偏好。请将其作为内置认知背景，自然融入回答与行动中（无需特意提及「从记忆库检索」等字样，直接顺畅生效）：',
  ];

  let totalLength = lines.join('\n').length;
  for (const res of cleanResults) {
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
    const content = card.content.replace(/\n/g, '\n  ').trim();
    if (totalLength + content.length > 4000) break;

    if (card.title.trim() === card.content.trim() || card.content.startsWith(card.title)) {
      lines.push(`- 【${catLabel}】${content}`);
    } else {
      lines.push(`- 【${catLabel}】${card.title}：${content}`);
    }
    totalLength += content.length;
  }

  return lines.join('\n') + '\n\n';
}

