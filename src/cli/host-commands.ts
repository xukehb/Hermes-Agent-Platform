import { Command } from 'commander';
import { CliContext, emit, type GlobalOptions } from './context.js';
import { getHostSystemInfo, formatBytes, formatUptime } from '../system/index.js';

export function registerHostCommands(root: Command, globals: () => GlobalOptions): void {
  root
    .command('host')
    .alias('sysinfo')
    .description('查看当前运行 CodexConnect 的宿主主机全景硬件指标与资源占用')
    .action(async () => {
      const g = globals();
      const ctx = new CliContext(g);
      const info = getHostSystemInfo();
      const cpuBar = renderProgressBar(info.cpu.usagePercent, 20);
      const memBar = renderProgressBar(info.memory.usedPercent, 20);

      const lines = [
        `\n🖥️ ════════════════════════════════════════════════════════════════════`,
        `   CodexConnect 宿主主机全景系统状态 (Host System Dashboard)`,
        `════════════════════════════════════════════════════════════════════`,
        `   主机名称:  ${info.network.hostname} (用户: ${info.os.user})`,
        `   操作系统:  ${info.os.type} ${info.os.release} (${info.os.platform} / ${info.os.arch})`,
        `   运行环境:  Node.js ${info.os.nodeVersion} (V8: ${info.os.versions?.v8 || '-'}, libuv: ${info.os.versions?.uv || '-'})`,
        `   进程 PID:  ${info.os.pid} (父进程 PPID: ${info.os.ppid})`,
        `   系统运行:  ${formatUptime(info.os.uptimeSeconds)} (服务运行: ${formatUptime(info.os.processUptimeSeconds)})`,
        `────────────────────────────────────────────────────────────────────`,
        `   ⚡ CPU 负载:  [${cpuBar}] ${info.cpu.usagePercent}%`,
        `      - 处理器:  ${info.cpu.model}`,
        `      - 拓扑规格: ${info.cpu.cores} 逻辑核心 @ ${info.cpu.speedMHz} MHz`,
        `      - 系统负载: ${(info.loadAvg || []).map(l => l.toFixed(2)).join(', ') || 'N/A'}`,
        `────────────────────────────────────────────────────────────────────`,
        `   💾 物理内存:  [${memBar}] ${info.memory.usedPercent}% (${formatBytes(info.memory.usedBytes)} / ${formatBytes(info.memory.totalBytes)})`,
        `      - 空闲可用: ${formatBytes(info.memory.freeBytes)}`,
        `      - 进程 RSS: ${formatBytes(info.memory.processRssBytes)} (堆使用: ${formatBytes(info.memory.processHeapUsedBytes)} / ${formatBytes(info.memory.processHeapTotalBytes)})`,
        `      - 底层缓存: External: ${formatBytes(info.memory.processExternalBytes)} | Buffers: ${formatBytes(info.memory.processArrayBuffersBytes)}`,
        `────────────────────────────────────────────────────────────────────`,
        `   📁 磁盘驱动卷与挂载分区 (${info.disk.partitions.length} 个卷):`,
        ...info.disk.partitions.map(p => {
          const dBar = renderProgressBar(p.usedPercent, 12);
          return `      - [${dBar}] ${p.mount.padEnd(6)}: ${p.usedPercent}% 已用 (${formatBytes(p.usedBytes)} / ${formatBytes(p.totalBytes)}, 空闲 ${formatBytes(p.freeBytes)})`;
        }),
        `────────────────────────────────────────────────────────────────────`,
        `   🚀 活跃高内存进程 Top 榜 (${info.topProcesses.length} 个进程):`,
        ...info.topProcesses.map((tp, idx) => `      #${idx + 1} ${tp.name.padEnd(24)} (PID: ${String(tp.pid).padEnd(6)}) | RAM: ${tp.memoryFormatted}`),
        `────────────────────────────────────────────────────────────────────`,
        `   🌐 网络网卡与接口 (${info.network.ips.length} 个接口):`,
        ...info.network.ips.map(ip => `      - ${ip.interface.padEnd(16)}: ${ip.address.padEnd(16)} (MAC: ${ip.mac || 'N/A'})`),
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
