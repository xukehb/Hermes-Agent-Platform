import { Command } from 'commander';
import { CliContext, emit, fail, type GlobalOptions } from './context.js';
import { MemoryStore } from '../memory/store.js';
import type { MemoryCategory } from '../memory/types.js';

export function registerMemoryCommands(root: Command, globals: () => GlobalOptions): void {
  const mem = root.command('memory').alias('mem').description('管理智能体长期向量记忆与跨会话偏好 (Vector Memory & RAG)');
  const store = MemoryStore.getInstance();

  mem
    .command('list')
    .description('列出所有已保存的长期记忆与偏好卡片')
    .option('--category <category>', '按类别过滤 (preference|fact|case|architecture)')
    .action((opts) => {
      const ctx = new CliContext(globals());
      const list = store.listMemories(opts.category);

      if (list.length === 0) {
        emit(ctx, '当前暂无保存的长期记忆，可通过 hap memory add 添加', []);
        return;
      }

      console.log('\n🧠 智能体长期记忆与偏好库：');
      console.table(
        list.map((m) => ({
          '记忆 ID': m.id,
          '类别': m.category,
          '标题': m.title,
          '标签': (m.tags || []).join(','),
          '调用次数': m.accessCount,
          '创建时间': new Date(m.createdAt).toLocaleDateString(),
        }))
      );
      emit(ctx, '', list);
    });

  mem
    .command('search <query>')
    .description('语义搜索向量记忆库')
    .option('--limit <limit>', '返回数量', '3')
    .action(async (query, opts) => {
      const ctx = new CliContext(globals());
      const results = await store.searchMemories({
        text: query,
        limit: parseInt(opts.limit, 10) || 3,
      });

      if (results.length === 0) {
        emit(ctx, `未找到与 “${query}” 相关的记忆`, []);
        return;
      }

      console.log(`\n🔍 与 “${query}” 相关的向量召回记忆：\n`);
      for (const res of results) {
        console.log(`• [${res.memory.category}] ${res.memory.title} (相似度: ${(res.score * 100).toFixed(1)}%)`);
        console.log(`  ${res.memory.content}\n`);
      }
      emit(ctx, '', results);
    });

  mem
    .command('add <title>')
    .description('新增一条长期记忆或偏好规则')
    .requiredOption('--content <content>', '记忆正文内容')
    .option('--category <category>', '类别 (preference|fact|case|architecture)', 'preference')
    .option('--tags <tags>', '标签，逗号分隔')
    .option('--workspace <path>', '绑定的特定项目目录')
    .action(async (title, opts) => {
      const ctx = new CliContext(globals());
      const tags = (opts.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);

      const card = await store.addMemory({
        title,
        content: opts.content,
        category: opts.category as MemoryCategory,
        tags,
        workspace: opts.workspace,
      });

      emit(ctx, `✓ 已成功存入长期记忆：[${card.category}] ${card.title} (${card.id})`, card);
    });

  mem
    .command('remove <id>')
    .description('根据 ID 删除一条长期记忆')
    .action((id) => {
      const ctx = new CliContext(globals());
      const ok = store.removeMemory(id);
      if (ok) {
        emit(ctx, `✓ 已删除记忆：${id}`, { id });
      } else {
        fail(`未找到记忆：${id}`);
      }
    });

  mem
    .command('update <id>')
    .description('更新一条长期记忆')
    .option('--title <title>', '新标题')
    .option('--content <content>', '新正文')
    .option('--category <category>', '新类别')
    .option('--tags <tags>', '新标签，逗号分隔')
    .option('--workspace <path>', '工作区')
    .option('--agent-id <id>', '指定智能体')
    .action(async (id, opts) => {
      const ctx = new CliContext(globals());
      const patch: Record<string, unknown> = {};
      if (opts.title !== undefined) patch.title = opts.title;
      if (opts.content !== undefined) patch.content = opts.content;
      if (opts.category !== undefined) patch.category = opts.category as MemoryCategory;
      if (opts.tags !== undefined) patch.tags = opts.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean);
      if (opts.workspace !== undefined) patch.workspace = opts.workspace;
      if (opts.agentId !== undefined) patch.agentId = opts.agentId;
      const card = await store.updateMemoryWithEmbedding(id, patch);
      if (!card) { fail(`未找到记忆：${id}`); return; }
      emit(ctx, `✓ 已更新记忆：${card.title}`, card);
    });

  mem
    .command('rebuild')
    .description('重建全部记忆向量索引')
    .action(async () => {
      const ctx = new CliContext(globals());
      const count = await store.rebuildEmbeddings();
      emit(ctx, `✓ 已重建 ${count} 条记忆的向量索引`, { count });
    });

  mem
    .command('extract <taskId>')
    .description('从任务文本提炼长期记忆')
    .requiredOption('--input <text>', '用户输入')
    .requiredOption('--output <text>', '助手输出')
    .option('--agent-id <id>', '智能体 ID', '')
    .option('--workspace <path>', '工作区')
    .action(async (taskId, opts) => {
      const ctx = new CliContext(globals());
      const cards = await store.extractTaskMemory({ taskId, agentId: opts.agentId, workspace: opts.workspace, userInput: opts.input, assistantOutput: opts.output });
      emit(ctx, `✓ 已提炼 ${cards.length} 条长期记忆`, cards);
    });

  mem
    .command('clean')
    .description('清理被污染或机械套话的废弃记忆')
    .action(() => {
      const ctx = new CliContext(globals());
      const purged = store.cleanCorruptedMemories();
      emit(ctx, `✓ 已成功清理 ${purged} 条被污染的废弃记忆`, { purged });
    });
}

