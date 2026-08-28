import { Command } from 'commander';
import { CliContext, emit, type GlobalOptions } from './context.js';
import { scanLocalDisk, cleanLocalDisk } from '../system/disk-cleaner.js';
import { formatBytes } from '../system/host-info.js';
import { RemoteClientManager, RemoteServerStore } from '../remote/index.js';

export function registerCleanCommands(root: Command, globals: () => GlobalOptions): void {
  root
    .command('clean')
    .description('AI 智能磁盘分析与安全清理（支持本地宿主机与远程服务器）')
    .option('-s, --server <name>', '指定要分析或清理的远程服务器 ID 或名称')
    .option('-y, --yes', '确认执行实际清理操作（缺省为体检扫描模式）', false)
    .option('--all', '清理全部可回收项（包括构建产物 dist/target 等）', false)
    .action(async (opts) => {
      const g = globals();
      const ctx = new CliContext(g);
      const isExecute = opts.yes === true;
      const isDryRun = !isExecute;
      const isAll = opts.all === true;

      // 1. 远程服务器清理
      if (opts.server) {
        const server = RemoteServerStore.getInstance().list().find(s =>
          s.id === opts.server || s.name === opts.server || s.host === opts.server
        );
        if (!server) {
          emit(ctx, `✗ 未找到指定的远程服务器 [${opts.server}]`, { error: 'Server not found' });
          return;
        }

        const client = RemoteClientManager.getInstance();
        if (isDryRun) {
          const cmd = 'df -h / && du -sh /var/log /tmp ~/.cache ~/.npm 2>/dev/null || true';
          const res = await client.execCommand(server, cmd);
          const out = [
            `\n🖥️ 远程服务器 [${server.name}] 磁盘体检报告 (Dry-Run 模式):`,
            `────────────────────────────────────────────────────────────────────`,
            res.stdout || res.stderr,
            `────────────────────────────────────────────────────────────────────`,
            `提示: 执行实际清理请运行: hap clean --server ${server.name}\n`,
          ].join('\n');
          emit(ctx, out, { server: server.name, report: res.stdout });
          return;
        } else {
          const cleanCmd = 'sudo apt-get clean -y 2>/dev/null; sudo journalctl --vacuum-size=100M 2>/dev/null; sudo docker system prune -f 2>/dev/null; rm -rf /tmp/* 2>/dev/null; df -h /';
          const res = await client.execCommand(server, cleanCmd);
          const out = [
            `\n🧹 远程服务器 [${server.name}] 磁盘安全清理完成！`,
            `────────────────────────────────────────────────────────────────────`,
            res.stdout || res.stderr,
            `────────────────────────────────────────────────────────────────────\n`,
          ].join('\n');
          emit(ctx, out, { server: server.name, result: res.stdout });
          return;
        }
      }

      // 2. 本地宿主机磁盘体检
      const report = await scanLocalDisk();

      if (isDryRun) {
        const lines = [
          `\n🧹 ════════════════════════════════════════════════════════════════════`,
          `   CodexConnect 本地宿主机磁盘体检报告 (Dry-Run 扫描模式)`,
          `════════════════════════════════════════════════════════════════════`,
          `   可释放空间总计:  ${formatBytes(report.totalCleanableBytes)}`,
          `   - 🟢 安全可清:   ${formatBytes(report.safeCleanableBytes)} (包管理缓存、旧日志、临时文件)`,
          `   - 🟡 建议确认:   ${formatBytes(report.reviewCleanableBytes)} (工程构建产物、Docker 悬空镜像)`,
          `────────────────────────────────────────────────────────────────────`,
          `   扫描发现的垃圾与缓存项清单 (${report.items.length} 项):`,
        ];

        for (const item of report.items) {
          const tag = item.safety === 'safe' ? '🟢 [安全]' : '🟡 [确认]';
          lines.push(`   ${tag} ${item.name.padEnd(20)} ${formatBytes(item.sizeBytes).padStart(10)} | ${item.path}`);
        }

        lines.push(`────────────────────────────────────────────────────────────────────`);
        lines.push(`💡 提示: 执行安全清理请运行: hap clean -y`);
        lines.push(`💡 提示: 清理全部项目构建请运行: hap clean -y --all\n`);

        emit(ctx, lines.join('\n'), report);
        return;
      }

      // 3. 执行本地清理
      const targetIds = isAll
        ? ['all']
        : report.items.filter(i => i.safety === 'safe').map(i => i.id);

      const result = await cleanLocalDisk(targetIds, report);

      const lines = [
        `\n🧹 ════════════════════════════════════════════════════════════════════`,
        `   CodexConnect 本地宿主机磁盘清理完成！`,
        `════════════════════════════════════════════════════════════════════`,
        `   本次成功释放空间:  ${formatBytes(result.cleanedBytes)}`,
        `────────────────────────────────────────────────────────────────────`,
        `   已清理项目:`,
        ...result.deletedItems.map(i => `   ✓ ${i}`),
      ];

      if (result.errors.length > 0) {
        lines.push(`────────────────────────────────────────────────────────────────────`);
        lines.push(`   ⚠️ 清理异常:`);
        result.errors.forEach(e => lines.push(`   ✗ ${e.id}: ${e.error}`));
      }

      lines.push(`════════════════════════════════════════════════════════════════════\n`);
      emit(ctx, lines.join('\n'), result);
    });
}
