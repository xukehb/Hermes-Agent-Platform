import http from 'node:http';
import { RemoteServerConfig, RemoteSystemInfo, RemoteExecResult } from './types.js';
import { execSshCommand, testSshConnection } from './ssh-installer.js';
import { RemoteServerStore } from './storage.js';

export class RemoteClientManager {
  private static instance: RemoteClientManager;
  private store: RemoteServerStore;

  constructor() {
    this.store = RemoteServerStore.getInstance();
  }

  static getInstance(): RemoteClientManager {
    if (!RemoteClientManager.instance) {
      RemoteClientManager.instance = new RemoteClientManager();
    }
    return RemoteClientManager.instance;
  }

  async testConnection(config: RemoteServerConfig): Promise<{
    ok: boolean;
    mode: 'daemon' | 'ssh' | 'offline';
    message: string;
    latencyMs: number;
    systemInfo?: RemoteSystemInfo;
  }> {
    const startTime = Date.now();
    const port = config.daemonPort || 9527;

    // 1. 尝试直连 Daemon 接口
    try {
      const daemonSysInfo = await this.fetchDaemonSysInfo(config);
      const latencyMs = Date.now() - startTime;
      this.store.updateStatus(config.id, {
        status: 'online',
        lastConnectedAt: Date.now(),
        systemInfo: daemonSysInfo,
        lastError: undefined,
      });
      return {
        ok: true,
        mode: 'daemon',
        message: 'HAP Daemon 双向通信正常',
        latencyMs,
        systemInfo: daemonSysInfo,
      };
    } catch {
      // 2. 如果 Daemon 无法访问，测试基础 SSH 连通性
      const sshRes = await testSshConnection(config);
      if (sshRes.ok) {
        this.store.updateStatus(config.id, {
          status: config.status === 'uninstalled' ? 'uninstalled' : 'offline',
          lastConnectedAt: Date.now(),
          lastError: `SSH 可连通，但 Daemon (端口 ${port}) 未响应`,
        });
        return {
          ok: true,
          mode: 'ssh',
          message: `SSH 连通正常 (Daemon 未启动或端口 ${port} 未放行)`,
          latencyMs: sshRes.latencyMs,
        };
      } else {
        this.store.updateStatus(config.id, {
          status: 'offline',
          lastError: sshRes.message,
        });
        return {
          ok: false,
          mode: 'offline',
          message: `连接失败: ${sshRes.message}`,
          latencyMs: sshRes.latencyMs,
        };
      }
    }
  }

  async getSystemInfo(config: RemoteServerConfig): Promise<RemoteSystemInfo> {
    try {
      const info = await this.fetchDaemonSysInfo(config);
      this.store.updateStatus(config.id, {
        status: 'online',
        systemInfo: info,
        lastConnectedAt: Date.now(),
      });
      return info;
    } catch {
      // 回退到 SSH 抓取基础信息
      const sshInfo = await this.fetchSshSysInfo(config);
      this.store.updateStatus(config.id, {
        systemInfo: sshInfo,
        lastConnectedAt: Date.now(),
      });
      return sshInfo;
    }
  }

  async execCommand(
    config: RemoteServerConfig,
    command: string,
    onStream?: (chunk: { type: 'stdout' | 'stderr' | 'exit' | 'error'; text?: string; code?: number }) => void
  ): Promise<RemoteExecResult> {
    const startTime = Date.now();

    // 优先尝试 HTTP Daemon 执行 (支持低开销和流式)
    try {
      return await this.execViaDaemon(config, command, onStream);
    } catch {
      // 回退到 SSH Exec
      return await this.execViaSsh(config, command, onStream);
    }
  }

  private fetchDaemonSysInfo(config: RemoteServerConfig, timeoutMs = 5000): Promise<RemoteSystemInfo> {
    return new Promise((resolve, reject) => {
      const port = config.daemonPort || 9527;
      const req = http.request(
        {
          hostname: config.host,
          port,
          path: '/api/sysinfo',
          method: 'GET',
          timeout: timeoutMs,
          headers: {
            'X-HAP-Token': config.token || '',
            'Authorization': config.token ? `Bearer ${config.token}` : '',
          },
        },
        (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.ok && json.data) {
                resolve(json.data as RemoteSystemInfo);
              } else {
                reject(new Error(json.error || '获取系统信息失败'));
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('获取系统信息超时'));
      });
      req.end();
    });
  }

  private execViaDaemon(
    config: RemoteServerConfig,
    command: string,
    onStream?: (chunk: { type: 'stdout' | 'stderr' | 'exit' | 'error'; text?: string; code?: number }) => void,
    timeoutMs = 120000
  ): Promise<RemoteExecResult> {
    return new Promise((resolve, reject) => {
      const port = config.daemonPort || 9527;
      const payload = JSON.stringify({ command, stream: !!onStream });
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: config.host,
          port,
          path: '/api/exec',
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-HAP-Token': config.token || '',
            'Authorization': config.token ? `Bearer ${config.token}` : '',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorBody = '';
            res.on('data', c => { errorBody += c; });
            res.on('end', () => {
              reject(new Error(`Daemon 响应异常 (${res.statusCode}): ${errorBody}`));
            });
            return;
          }

          if (onStream) {
            let fullStdout = '';
            let fullStderr = '';
            let exitCode = 0;

            let buffer = '';
            res.on('data', chunk => {
              buffer += chunk.toString('utf-8');
              const lines = buffer.split('\n\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const event = JSON.parse(line.slice(6));
                    if (event.type === 'stdout') {
                      fullStdout += event.text;
                      onStream(event);
                    } else if (event.type === 'stderr') {
                      fullStderr += event.text;
                      onStream(event);
                    } else if (event.type === 'exit') {
                      exitCode = event.code;
                      onStream(event);
                    } else if (event.type === 'error') {
                      onStream(event);
                    }
                  } catch {}
                }
              }
            });

            res.on('end', () => {
              resolve({
                code: exitCode,
                stdout: fullStdout,
                stderr: fullStderr,
                durationMs: Date.now() - startTime,
              });
            });
          } else {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json.ok && json.data) {
                  resolve(json.data);
                } else {
                  reject(new Error(json.error || '执行命令失败'));
                }
              } catch (err) {
                reject(err);
              }
            });
          }
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('命令执行超时'));
      });
      req.write(payload);
      req.end();
    });
  }

  private async execViaSsh(
    config: RemoteServerConfig,
    command: string,
    onStream?: (chunk: { type: 'stdout' | 'stderr' | 'exit' | 'error'; text?: string; code?: number }) => void
  ): Promise<RemoteExecResult> {
    const startTime = Date.now();
    const res = await execSshCommand(config, command);
    if (onStream) {
      if (res.stdout) onStream({ type: 'stdout', text: res.stdout });
      if (res.stderr) onStream({ type: 'stderr', text: res.stderr });
      onStream({ type: 'exit', code: res.code });
    }
    return {
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - startTime,
    };
  }

  private async fetchSshSysInfo(config: RemoteServerConfig): Promise<RemoteSystemInfo> {
    const cmd = `
      uname -n
      uname -s
      uname -m
      cat /etc/os-release 2>/dev/null || uname -r
      cat /proc/uptime 2>/dev/null || uptime
      nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo "1"
      cat /proc/meminfo 2>/dev/null || free -b
    `;
    const res = await execSshCommand(config, cmd);
    const lines = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);

    const hostname = lines[0] || config.host;
    const platform = (lines[1] || 'linux').toLowerCase();
    const arch = lines[2] || 'x64';
    const osRelease = lines[3] || 'Linux';
    const cpuCount = parseInt(lines[5] || '1', 10) || 1;

    let totalMemBytes = 1024 * 1024 * 1024 * 4; // default 4GB
    let freeMemBytes = 1024 * 1024 * 1024 * 2;
    const memTotalMatch = res.stdout.match(/MemTotal:\s+(\d+)\s+kB/);
    const memFreeMatch = res.stdout.match(/MemAvailable:\s+(\d+)\s+kB/) || res.stdout.match(/MemFree:\s+(\d+)\s+kB/);

    const totalStr = memTotalMatch?.[1];
    const freeStr = memFreeMatch?.[1];
    if (totalStr) totalMemBytes = parseInt(totalStr, 10) * 1024;
    if (freeStr) freeMemBytes = parseInt(freeStr, 10) * 1024;

    const usedMemPercent = Number((((totalMemBytes - freeMemBytes) / totalMemBytes) * 100).toFixed(1));

    return {
      hostname,
      platform,
      arch,
      osRelease,
      uptimeSeconds: 0,
      cpuCount,
      cpuModel: 'Remote CPU',
      cpuUsagePercent: 10,
      totalMemBytes,
      freeMemBytes,
      usedMemPercent,
      loadAvg: [0.1, 0.1, 0.1],
      timestamp: Date.now(),
    };
  }
}
