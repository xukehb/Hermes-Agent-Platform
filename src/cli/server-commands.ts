import { Command } from 'commander';
import { isCancel, cancel, intro, outro, text as promptText, select } from '@clack/prompts';
import { CliContext, emit, fail, type GlobalOptions } from './context.js';
import { orDash, renderTable, yesNo } from './render.js';
import { RemoteServerStore } from '../remote/storage.js';
import { RemoteClientManager } from '../remote/client.js';
import { installRemoteDaemon } from '../remote/ssh-installer.js';
import { RemoteServerConfig } from '../remote/types.js';

export function registerServerCommands(root: Command, globals: () => GlobalOptions): void {
  const server = root.command('server').description('管理远程服务器与 Agent 守护节点');
  const store = RemoteServerStore.getInstance();
  const clientManager = RemoteClientManager.getInstance();

  server
    .command('list')
    .description('列出所有已添加的远程服务器节点')
    .action(() => {
      const ctx = new CliContext(globals());
      const servers = store.list();
      const rows = servers.map((s) => [
        s.id,
        s.name,
        `${s.host}:${s.port}`,
        s.username,
        s.status,
        s.systemInfo ? `${s.systemInfo.cpuUsagePercent}% CPU / ${s.systemInfo.usedMemPercent}% RAM` : '—',
        s.lastConnectedAt ? new Date(s.lastConnectedAt).toLocaleTimeString() : '—',
      ]);
      emit(
        ctx,
        renderTable(['ID', '名称', '地址', '用户', '状态', '资源占用', '最近连接'], rows),
        servers
      );
    });

  server
    .command('add [id]')
    .description('添加远程服务器配置 (支持交互式或参数输入)')
    .option('--host <host>', '服务器 IP 或域名')
    .option('--port <port>', 'SSH 端口', '22')
    .option('--user <user>', 'SSH 用户名', 'root')
    .option('--password <password>', 'SSH 密码')
    .option('--name <name>', '节点显示别名')
    .option('--daemon-port <port>', 'HAP 守护进程端口', '9527')
    .action(async (idArg, opts) => {
      const ctx = new CliContext(globals());
      let id = idArg;
      let host = opts.host;
      let port = parseInt(opts.port, 10) || 22;
      let username = opts.user || 'root';
      let password = opts.password;
      let name = opts.name;
      let daemonPort = parseInt(opts.daemonPort, 10) || 9527;

      if (!id || !host) {
        intro('➕ 添加远程服务器节点');
        if (!id) {
          const res = await promptText({
            message: '请输入服务器节点唯一 ID (例如 vps-1, node-dev):',
            validate: (v) => (!v || !v.trim() ? 'ID 不能为空' : undefined),
          });
          if (isCancel(res)) return cancel('已取消操作');
          id = res.trim();
        }

        if (!host) {
          const res = await promptText({
            message: '请输入服务器 IP 或域名 (例如 192.168.1.100 或 123.45.67.89):',
            validate: (v) => (!v || !v.trim() ? '主机地址不能为空' : undefined),
          });
          if (isCancel(res)) return cancel('已取消操作');
          host = res.trim();
        }

        if (!opts.name) {
          const res = await promptText({
            message: '请输入显示名称 (可选，直接回车使用 IP):',
            defaultValue: host,
          });
          if (isCancel(res)) return cancel('已取消操作');
          name = res.trim();
        }

        if (!opts.password) {
          const res = await promptText({
            message: '请输入 SSH 登录密码:',
          });
          if (isCancel(res)) return cancel('已取消操作');
          password = res;
        }
      }

      const saved = store.upsert({
        id,
        name: name || host,
        host,
        port,
        username,
        authType: 'password',
        password,
        daemonPort,
        status: 'uninstalled',
      });

      emit(
        ctx,
        `✓ 服务器 [${saved.id}] (${saved.name} - ${saved.host}:${saved.port}) 添加成功！\n可运行 'hap server test ${saved.id}' 或 'hap server install ${saved.id}'`,
        saved
      );
    });

  server
    .command('test <id>')
    .description('测试远程服务器连通性 (SSH / Daemon)')
    .action(async (id) => {
      const ctx = new CliContext(globals());
      const s = store.get(id);
      if (!s) return fail(`未找到服务器: ${id}`);

      console.log(`正在探测服务器 [${s.name}] (${s.host}:${s.port})...`);
      const res = await clientManager.testConnection(s);
      if (res.ok) {
        emit(
          ctx,
          `✓ 连接成功！[模式: ${res.mode.toUpperCase()}] 耗时: ${res.latencyMs}ms\n信息: ${res.message}`,
          res
        );
      } else {
        fail(`✗ 连接失败: ${res.message}`);
      }
    });

  server
    .command('install <id>')
    .description('一键在远程服务器上部署并拉起 HAP 守护进程')
    .action(async (id) => {
      const ctx = new CliContext(globals());
      const s = store.get(id);
      if (!s) return fail(`未找到服务器: ${id}`);

      console.log(`🚀 开始在服务器 [${s.name}] (${s.host}) 上一键部署 HAP Agent 守护进程...\n`);

      const res = await installRemoteDaemon(s, (event) => {
        const icon = event.status === 'success' ? '✓' : event.status === 'failed' ? '✗' : '⏳';
        console.log(`[${event.stepIndex}/${event.totalSteps}] ${icon} ${event.message}`);
        if (event.details) {
          console.log(`    ↳ ${event.details.trim().split('\n')[0]}`);
        }
      });

      if (res.ok) {
        store.updateStatus(s.id, {
          status: 'online',
          token: res.token,
          daemonPort: res.daemonPort,
          lastConnectedAt: Date.now(),
        });
        emit(
          ctx,
          `\n✨ 远端 Agent 守护进程部署成功！\n- 通信端口: ${res.daemonPort}\n- 安全 Token: ${res.token}\n可通过 'hap server info ${s.id}' 或 'hap server exec ${s.id} "uname -a"' 进行实时操控`,
          res
        );
      } else {
        store.updateStatus(s.id, { status: 'error', lastError: res.error || undefined });
        fail(`\n✗ 部署失败: ${res.error}`);
      }
    });

  server
    .command('exec <id> <command>')
    .description('在远程服务器上执行命令并获取输出')
    .action(async (id, command) => {
      const ctx = new CliContext(globals());
      const s = store.get(id);
      if (!s) return fail(`未找到服务器: ${id}`);

      console.log(`🖥️  正在向 [${s.name}] 发送执行: ${command}\n`);
      const res = await clientManager.execCommand(s, command, (chunk) => {
        if (chunk.type === 'stdout' && chunk.text) process.stdout.write(chunk.text);
        if (chunk.type === 'stderr' && chunk.text) process.stderr.write(chunk.text);
      });

      if (res.code === 0) {
        emit(ctx, `\n✓ 执行完毕 (耗时: ${res.durationMs}ms, 退出码: 0)`, res);
      } else {
        fail(`\n✗ 执行异常退出 (耗时: ${res.durationMs}ms, 退出码: ${res.code})`);
      }
    });

  server
    .command('info <id>')
    .description('获取远程服务器实时系统资源监控数据')
    .action(async (id) => {
      const ctx = new CliContext(globals());
      const s = store.get(id);
      if (!s) return fail(`未找到服务器: ${id}`);

      try {
        const info = await clientManager.getSystemInfo(s);
        const memUsedGb = ((info.totalMemBytes - info.freeMemBytes) / (1024 * 1024 * 1024)).toFixed(2);
        const memTotalGb = (info.totalMemBytes / (1024 * 1024 * 1024)).toFixed(2);
        const hours = Math.floor(info.uptimeSeconds / 3600);
        const minutes = Math.floor((info.uptimeSeconds % 3600) / 60);

        console.log(`\n📊 远程服务器 [${s.name}] 实时状态：`);
        console.log(`- 主机名: ${info.hostname} (${info.platform} ${info.arch})`);
        console.log(`- 系统发行版: ${info.osRelease}`);
        console.log(`- CPU 占用: ${info.cpuUsagePercent}% (${info.cpuCount} 核 - ${info.cpuModel})`);
        console.log(`- 内存占用: ${info.usedMemPercent}% (${memUsedGb} GB / ${memTotalGb} GB)`);
        console.log(`- 系统负载: ${info.loadAvg.join(', ')}`);
        console.log(`- 运行时间: ${hours} 小时 ${minutes} 分钟`);
        if (info.nodeVersion) console.log(`- Node 版本: ${info.nodeVersion}`);

        emit(ctx, '', info);
      } catch (err) {
        fail(`获取系统状态失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  server
    .command('remove <id>')
    .description('移除远程服务器配置')
    .action((id) => {
      const ctx = new CliContext(globals());
      const removed = store.remove(id);
      if (removed) {
        emit(ctx, `✓ 已移除服务器: ${id}`, { id });
      } else {
        fail(`未找到服务器: ${id}`);
      }
    });
}
