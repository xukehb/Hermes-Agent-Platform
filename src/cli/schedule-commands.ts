import { Command } from 'commander';
import { CliContext, emit, fail, type GlobalOptions } from './context.js';
import { ScheduleStore } from '../scheduler/storage.js';
import { SchedulerEngine } from '../scheduler/engine.js';
import { describeCron } from '../scheduler/cron-parser.js';

export function registerScheduleCommands(root: Command, globals: () => GlobalOptions): void {
  const sched = root.command('schedule').alias('cron').description('管理智能体主动定时工作流 (Agent Cron Workflows)');
  const store = ScheduleStore.getInstance();

  sched
    .command('list')
    .description('列出所有已配置的智能体定时任务')
    .action(() => {
      const ctx = new CliContext(globals());
      const jobs = store.listJobs();
      if (jobs.length === 0) {
        emit(ctx, '当前暂无配置的定时任务，可通过 hap schedule add 创建', []);
        return;
      }

      const rows = jobs.map((j) => [
        j.id,
        j.name,
        j.enabled ? '[启用]' : '[禁用]',
        `${j.cron} (${describeCron(j.cron)})`,
        j.agent,
        j.lastStatus ? (j.lastStatus === 'success' ? '✓ 成功' : '✗ 失败') : '—',
        j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : '—',
      ]);

      console.log('\n智能体主动定时工作流列表：');
      console.table(
        rows.map(r => ({
          '任务 ID': r[0],
          '任务名称': r[1],
          '状态': r[2],
          'Cron 周期': r[3],
          '执行智能体': r[4],
          '上次结果': r[5],
          '上次执行时间': r[6],
        }))
      );
      emit(ctx, '', jobs);
    });

  sched
    .command('add <name>')
    .description('新增或更新一个智能体定时任务')
    .requiredOption('--cron <cron>', 'Cron 周期表达式，如 "0 9 * * 1-5" 或 "*/30 * * * *"')
    .requiredOption('--prompt <prompt>', '触发时下发给智能体的指令提示词')
    .option('--agent <agentId>', '执行任务的智能体，缺省为 coder', 'coder')
    .option('--workspace <path>', '任务执行绑定的代码工程目录')
    .option('--notify <channels>', '通知渠道，逗号分隔 (如 wechat,telegram,logs)', 'logs')
    .action((name, opts) => {
      const ctx = new CliContext(globals());
      const notifyChannels = (opts.notify || 'logs').split(',').map((s: string) => s.trim()) as ('wechat' | 'telegram' | 'logs')[];

      const job = store.upsertJob({
        name,
        cron: opts.cron,
        agent: opts.agent,
        workspace: opts.workspace,
        prompt: opts.prompt,
        notifyChannels,
        enabled: true,
      });

      emit(
        ctx,
        `✓ 定时任务 [${job.name}] (${job.id}) 已成功创建！\n- 周期: ${job.cron} (${describeCron(job.cron)})\n- 智能体: ${job.agent}\n可通过 'hap schedule run ${job.id}' 进行立即手动测试`,
        job
      );
    });

  sched
    .command('run <id>')
    .description('立即手动触发执行指定的定时任务')
    .action(async (id) => {
      const ctx = new CliContext(globals());
      const job = store.getJob(id);
      if (!job) return fail(`未找到定时任务: ${id}`);

      console.log(`正在手动拉起定时任务 [${job.name}] (${job.id}) ...\n`);
      const engine = SchedulerEngine.getInstance();
      const res = await engine.executeJob(job);

      if (res.status === 'success') {
        emit(ctx, `\n✓ 执行成功 (耗时: ${res.durationMs}ms)\n\n【输出摘要】:\n${res.output}`, res);
      } else {
        fail(`\n✗ 执行失败: ${res.error}`);
      }
    });

  sched
    .command('toggle <id>')
    .description('启用或暂停指定的定时任务')
    .action((id) => {
      const ctx = new CliContext(globals());
      const job = store.toggleJob(id);
      if (!job) return fail(`未找到定时任务: ${id}`);

      emit(ctx, `✓ 任务 [${job.name}] 状态已更新为: ${job.enabled ? '[启用]' : '[禁用]'}`, job);
    });

  sched
    .command('remove <id>')
    .description('删除指定的定时任务')
    .action((id) => {
      const ctx = new CliContext(globals());
      const ok = store.removeJob(id);
      if (ok) {
        emit(ctx, `✓ 已删除定时任务: ${id}`, { id });
      } else {
        fail(`未找到定时任务: ${id}`);
      }
    });
}
