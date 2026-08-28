/**
 * 远程服务器控制工具组 (remote_exec, remote_sysinfo, remote_list_servers)
 * 允许 AI 智能体 (Agent) 自主操控与巡检配置好的远端服务器。
 */

import { z } from 'zod';
import { defineTool } from '../define.js';
import { RemoteServerStore } from '../../remote/storage.js';
import { RemoteClientManager } from '../../remote/client.js';
import { RemoteServerConfig } from '../../remote/types.js';

function pickServer(serverIdOrHost?: string): { server?: RemoteServerConfig | undefined; error?: string | undefined } {
  const store = RemoteServerStore.getInstance();
  const servers = store.list();

  if (servers.length === 0) {
    return {
      error: '当前系统未配置任何远程服务器。请先在 GUI「远程服务器 & 节点」或命令行 `hap server add` 添加服务器凭据。',
    };
  }

  if (!serverIdOrHost) {
    if (servers.length === 1 && servers[0]) {
      return { server: servers[0] };
    }
    const onlineOne = servers.find((s) => s.status === 'online');
    if (onlineOne) {
      return { server: onlineOne };
    }
    return {
      error: `系统存在多台服务器 [${servers.map((s) => s.id).join(', ')}]，请在参数中指定 server 字段 (服务器 ID 或 IP)。`,
    };
  }

  const found = servers.find((s) => s.id === serverIdOrHost || s.host === serverIdOrHost || s.name === serverIdOrHost);
  if (!found) {
    return {
      error: `未找到匹配的服务器 [${serverIdOrHost}]。可用服务器列表: ${servers.map((s) => `${s.id}(${s.host})`).join(', ')}`,
    };
  }

  return { server: found };
}

export const remoteListServersTool = defineTool({
  name: 'remote_list_servers',
  description: '列出所有已配置的远程服务器节点及其在线状态、IP 与硬件资源信息。在操控未知服务器前可先调用此工具探查。',
  schema: z.object({}),
  run: async () => {
    const store = RemoteServerStore.getInstance();
    const servers = store.list();

    if (servers.length === 0) {
      return {
        content: '当前未配置任何远程服务器节点。',
      };
    }

    const summary = servers.map((s) => {
      const info = s.systemInfo;
      const memGb = info ? `${((info.totalMemBytes - info.freeMemBytes) / 1073741824).toFixed(1)}G/${(info.totalMemBytes / 1073741824).toFixed(1)}G` : '未知';
      return [
        `- ID: **${s.id}** (${s.name})`,
        `  地址: \`${s.username}@${s.host}:${s.port}\``,
        `  状态: \`${s.status}\``,
        `  系统: ${info ? `${info.osRelease} (${info.arch})` : '未知'}`,
        `  资源: ${info ? `CPU ${info.cpuUsagePercent}% | 内存 ${memGb} (${info.usedMemPercent}%)` : '未采集'}`,
      ].join('\n');
    }).join('\n\n');

    return {
      content: `已配置的远程服务器列表 (${servers.length} 台):\n\n${summary}`,
    };
  },
});

export const remoteExecTool = defineTool({
  name: 'remote_exec',
  description: '在远程 Linux 服务器上执行指定的 Shell 命令并获取实时输出。可用于部署服务、拉取代码、查看日志、排查故障等。',
  schema: z.object({
    command: z.string().min(1).describe('要在远程服务器上执行的 Shell 命令，例如: ls -la /var/log, docker ps, systemctl status nginx, git pull, npm run build'),
    server: z.string().optional().describe('目标服务器的 ID、名称或 IP 地址。若系统中仅配置了一台服务器可省略'),
  }),
  run: async (args) => {
    const { server, error } = pickServer(args.server);
    if (error || !server) {
      return { content: error || '未找到目标服务器', isError: true };
    }

    const client = RemoteClientManager.getInstance();
    const started = Date.now();

    try {
      const res = await client.execCommand(server, args.command);
      const elapsed = Date.now() - started;

      let output = '';
      if (res.stdout) output += res.stdout;
      if (res.stderr) output += (output ? '\n' : '') + '[stderr]\n' + res.stderr;
      if (!output) output = '(命令执行完毕，无标准输出)';

      const isError = res.code !== 0;
      const header = `[Remote: ${server.name} (${server.host})] 执行结果 (耗时 ${elapsed}ms, 退出码: ${res.code}):\n`;

      return {
        content: header + '```\n' + output.trim() + '\n```',
        isError,
      };
    } catch (err) {
      return {
        content: `向远程服务器 [${server.name}] 发送执行指令失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const remoteSysinfoTool = defineTool({
  name: 'remote_sysinfo',
  description: '查询远程服务器的实时硬件指标（CPU 占用、内存消耗、系统负载、操作系统版本、开机时长等）。',
  schema: z.object({
    server: z.string().optional().describe('目标服务器的 ID、名称或 IP 地址。若只有一台可省略'),
  }),
  run: async (args) => {
    const { server, error } = pickServer(args.server);
    if (error || !server) {
      return { content: error || '未找到目标服务器', isError: true };
    }

    const client = RemoteClientManager.getInstance();
    try {
      const info = await client.getSystemInfo(server);
      const memUsedGb = ((info.totalMemBytes - info.freeMemBytes) / 1073741824).toFixed(2);
      const memTotalGb = (info.totalMemBytes / 1073741824).toFixed(2);
      const hours = Math.floor(info.uptimeSeconds / 3600);
      const minutes = Math.floor((info.uptimeSeconds % 3600) / 60);

      const content = [
        `### 远程服务器 [${server.name}] 实时硬件状态`,
        `- **主机名与架构**: \`${info.hostname}\` (${info.platform} ${info.arch})`,
        `- **发行版**: ${info.osRelease}`,
        `- **CPU 占用**: **${info.cpuUsagePercent}%** (${info.cpuCount} 核 - ${info.cpuModel})`,
        `- **内存占用**: **${info.usedMemPercent}%** (${memUsedGb} GB / ${memTotalGb} GB)`,
        `- **系统负载 (1/5/15m)**: \`${info.loadAvg.join(', ')}\``,
        `- **系统运行时长**: ${hours} 小时 ${minutes} 分钟`,
        info.nodeVersion ? `- **Node.js 版本**: \`${info.nodeVersion}\`` : '',
      ].filter(Boolean).join('\n');

      return { content };
    } catch (err) {
      return {
        content: `获取远程服务器 [${server.name}] 状态失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const remoteUpgradeDaemonTool = defineTool({
  name: 'remote_upgrade_daemon',
  description: '自动对指定的远程 Linux 服务器升级或重新部署 HAP 守护进程，并验证健康检查状态。在守护进程版本落后、端口异常或需要重新发布新脚本时调用。',
  schema: z.object({
    server: z.string().optional().describe('目标服务器的 ID、名称或 IP 地址。若系统中只有一台服务器可省略'),
  }),
  run: async (args) => {
    const { server, error } = pickServer(args.server);
    if (error || !server) {
      return { content: error || '未找到目标服务器', isError: true };
    }

    const { installRemoteDaemon } = await import('../../remote/ssh-installer.js');
    const store = RemoteServerStore.getInstance();

    store.updateStatus(server.id, { status: 'installing' });
    const logs: string[] = [];

    const res = await installRemoteDaemon(server, (evt) => {
      logs.push(`[${evt.status.toUpperCase()}] ${evt.message}`);
    });

    if (res.ok) {
      store.updateStatus(server.id, {
        status: 'online',
        token: res.token,
        daemonPort: res.daemonPort,
        lastConnectedAt: Date.now(),
      });
      return {
        content: [
          `### ✅ 远程服务器 [${server.name}] HAP 守护进程升级成功！`,
          `- **主机**: \`${server.host}:${server.port}\``,
          `- **守护进程端口**: \`${res.daemonPort}\``,
          `- **运行状态**: \`online\` (健康检查与 Token 认证已就绪)`,
          '',
          '**升级与部署日志摘要**:',
          '```',
          logs.slice(-8).join('\n'),
          '```',
        ].join('\n'),
      };
    } else {
      store.updateStatus(server.id, {
        status: 'error',
        lastError: res.error,
      });
      return {
        content: [
          `### ❌ 远程服务器 [${server.name}] HAP 守护进程升级失败`,
          `- **错误提示**: ${res.error}`,
          '',
          '**排查日志**:',
          '```',
          logs.join('\n'),
          '```',
        ].join('\n'),
        isError: true,
      };
    }
  },
});
