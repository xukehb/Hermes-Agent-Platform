import { z } from 'zod';
import { defineTool } from '../define.js';
import { getHostSystemInfo, formatBytes, formatUptime } from '../../system/index.js';

export const hostSysinfoTool = defineTool({
  name: 'host_sysinfo',
  description: '获取当前运行 CodexConnect 的宿主主机实时系统状态（CPU 型号/核心数/使用率、物理内存/进程内存使用情况、操作系统版本、连续运行时间、局域网 IP 等）。',
  schema: z.object({}),
  run: async () => {
    const info = getHostSystemInfo();

    const output = [
      `🖥️ **宿主主机系统状态 (Host System Diagnostics)**`,
      `- **主机名**: \`${info.network.hostname}\` (用户: \`${info.os.user}\`)`,
      `- **操作系统**: \`${info.os.type} ${info.os.release}\` (${info.os.platform} / ${info.os.arch})`,
      `- **Node.js 运行时**: \`${info.os.nodeVersion}\` (进程 PID: \`${info.os.pid}\`)`,
      `- **系统运行时间**: ${formatUptime(info.os.uptimeSeconds)} (CodexConnect 连续运行: ${formatUptime(info.os.processUptimeSeconds)})`,
      ``,
      `⚡ **CPU 状态**:`,
      `- 型号: \`${info.cpu.model}\``,
      `- 核心数: \`${info.cpu.cores}\` 核心 (${info.cpu.speedMHz} MHz)`,
      `- 当前使用率: **${info.cpu.usagePercent}%**`,
      ``,
      `💾 **内存状态 (RAM)**:`,
      `- 物理内存总计: \`${formatBytes(info.memory.totalBytes)}\``,
      `- 已用内存: \`${formatBytes(info.memory.usedBytes)}\` (**${info.memory.usedPercent}%**)`,
      `- 空闲可用内存: \`${formatBytes(info.memory.freeBytes)}\``,
      `- CodexConnect 进程占用 (RSS): \`${formatBytes(info.memory.processRssBytes)}\``,
      `- Node.js 堆内存用量: \`${formatBytes(info.memory.processHeapUsedBytes)}\` / \`${formatBytes(info.memory.processHeapTotalBytes)}\``,
      ``,
      `🌐 **网络 IP 地址**:`,
      ...info.network.ips.map(ip => `- 网卡 \`${ip.interface}\`: \`${ip.address}\``),
    ].join('\n');

    return {
      content: output,
      isError: false,
    };
  },
});
