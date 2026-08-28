import { Command } from 'commander';
import { CliContext, emit, type GlobalOptions } from './context.js';
import { getHostSystemInfo, formatBytes, formatUptime } from '../system/index.js';

export function registerHostCommands(root: Command, globals: () => GlobalOptions): void {
  root
    .command('host')
    .alias('sysinfo')
    .description('查看当前运行 CodexConnect 的宿主主机实时状态与资源占用')
    .action(async () => {
      const g = globals();
      const ctx = new CliContext(g);
      const info = getHostSystemInfo();
      const cpuBar = renderProgressBar(info.cpu.usagePercent, 20);
      const memBar = renderProgressBar(info.memory.usedPercent, 20);

      const lines = [
        `\n🖥️ ════════════════════════════════════════════════════════════════════`,
        `   CodexConnect 宿主主机实时系统状态 (Host System Status)`,
        `════════════════════════════════════════════════════════════════════`,
        `   主机名称:  ${info.network.hostname} (用户: ${info.os.user})`,
        `   操作系统:  ${info.os.type} ${info.os.release} (${info.os.platform} / ${info.os.arch})`,
        `   运行环境:  Node.js ${info.os.nodeVersion} (进程 PID: ${info.os.pid})`,
        `   系统运行:  ${formatUptime(info.os.uptimeSeconds)} (服务运行: ${formatUptime(info.os.processUptimeSeconds)})`,
        `────────────────────────────────────────────────────────────────────`,
        `   ⚡ CPU 状态:  [${cpuBar}] ${info.cpu.usagePercent}%`,
        `      - 型号:    ${info.cpu.model}`,
        `      - 规格:    ${info.cpu.cores} 核心 @ ${info.cpu.speedMHz} MHz`,
        `────────────────────────────────────────────────────────────────────`,
        `   💾 物理内存:  [${memBar}] ${info.memory.usedPercent}% (${formatBytes(info.memory.usedBytes)} / ${formatBytes(info.memory.totalBytes)})`,
        `      - 空闲:    ${formatBytes(info.memory.freeBytes)}`,
        `      - 进程RSS: ${formatBytes(info.memory.processRssBytes)} (堆用量: ${formatBytes(info.memory.processHeapUsedBytes)} / ${formatBytes(info.memory.processHeapTotalBytes)})`,
        `────────────────────────────────────────────────────────────────────`,
        `   🌐 网络地址:`,
        ...info.network.ips.map(ip => `      - ${ip.interface.padEnd(12)}: ${ip.address}`),
        `════════════════════════════════════════════════════════════════════\n`,
      ];

      emit(ctx, lines.join('\n'), info);
    });
}

function renderProgressBar(percent: number, totalBlocks = 20): string {
  const p = Math.min(100, Math.max(0, percent));
  const filled = Math.round((p / 100) * totalBlocks);
  const empty = totalBlocks - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
