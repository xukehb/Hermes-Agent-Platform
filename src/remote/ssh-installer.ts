import { Client, ConnectConfig } from 'ssh2';
import crypto from 'node:crypto';
import { RemoteServerConfig, InstallProgressEvent, InstallStepId } from './types.js';
import { generateRemoteDaemonScript } from './daemon-script.js';

export function buildSshConfig(config: RemoteServerConfig): ConnectConfig {
  const sshConfig: ConnectConfig = {
    host: config.host,
    port: config.port || 22,
    username: config.username || 'root',
    readyTimeout: 20000,
    keepaliveInterval: 10000,
  };

  if (config.authType === 'password' && config.password !== undefined) {
    sshConfig.password = config.password;
  } else if (config.authType === 'privateKey' && config.privateKey !== undefined) {
    sshConfig.privateKey = config.privateKey;
    if (config.passphrase !== undefined) {
      sshConfig.passphrase = config.passphrase;
    }
  }

  return sshConfig;
}

export function execSshCommand(
  config: RemoteServerConfig,
  command: string,
  timeoutMs = 120000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let isResolved = false;

    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        conn.end();
        reject(new Error(`SSH 命令执行超时 (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    conn.on('ready', () => {
      // 统一注入基础环境变量与标准可执行路径，保证非交互式 SSH 会话也能正确寻址
      const wrappedCommand = `export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/opt/node-dist/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -n 1)/bin:$HOME/.local/bin:$PATH"; ${command}`;

      conn.exec(wrappedCommand, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          isResolved = true;
          conn.end();
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          isResolved = true;
          conn.end();
          resolve({
            code: typeof code === 'number' ? code : 0,
            stdout,
            stderr,
          });
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf-8');
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8');
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      if (!isResolved) {
        isResolved = true;
        reject(err);
      }
    });

    try {
      conn.connect(buildSshConfig(config));
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function testSshConnection(
  config: RemoteServerConfig
): Promise<{ ok: boolean; message: string; latencyMs: number; osInfo?: string }> {
  const startTime = Date.now();
  try {
    const res = await execSshCommand(config, 'uname -sm && uname -r && whoami', 15000);
    const latencyMs = Date.now() - startTime;
    if (res.code === 0) {
      return {
        ok: true,
        message: 'SSH 连通成功',
        latencyMs,
        osInfo: res.stdout.trim().replace(/\n/g, ' / '),
      };
    } else {
      return {
        ok: false,
        message: `SSH 执行返回非零状态码: ${res.code} - ${res.stderr || res.stdout}`,
        latencyMs,
      };
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startTime,
    };
  }
}

export async function installRemoteDaemon(
  config: RemoteServerConfig,
  onProgress?: (event: InstallProgressEvent) => void
): Promise<{ ok: boolean; token: string; daemonPort: number; error?: string }> {
  const token = config.token || crypto.randomBytes(24).toString('hex');
  const daemonPort = config.daemonPort || 9527;

  const steps: { id: InstallStepId; name: string }[] = [
    { id: 'ssh_connect', name: '连接远程 SSH 服务' },
    { id: 'check_os', name: '探测服务器系统架构与环境' },
    { id: 'check_node', name: '检测 Node.js 运行时环境' },
    { id: 'install_node', name: '按需配置/安装 Node.js 运行环境' },
    { id: 'deploy_daemon', name: '下发 HAP 守护进程脚本与配置' },
    { id: 'setup_service', name: '注册系统服务 (systemd / 进程守护)' },
    { id: 'verify_health', name: '校验守护进程健康状态与双向通信' },
  ];

  const totalSteps = steps.length;

  function report(
    stepIndex: number,
    status: 'pending' | 'running' | 'success' | 'failed',
    message: string,
    details?: string
  ) {
    const curStep = steps[stepIndex];
    if (onProgress && curStep) {
      onProgress({
        step: curStep.id,
        stepIndex: stepIndex + 1,
        totalSteps,
        status,
        message,
        details: details !== undefined ? details : undefined,
        timestamp: Date.now(),
      });
    }
  }

  try {
    // 步骤 1: SSH 连接验证
    report(0, 'running', '正在连接目标服务器 SSH 端口...');
    const connTest = await testSshConnection(config);
    if (!connTest.ok) {
      report(0, 'failed', `SSH 连接失败: ${connTest.message}`);
      return { ok: false, token, daemonPort, error: connTest.message };
    }
    report(0, 'success', `SSH 连接成功 (延迟: ${connTest.latencyMs}ms)`, connTest.osInfo);

    // 步骤 2: 探测操作系统
    report(1, 'running', '正在探测操作系统发行版与内核架构...');
    const osRes = await execSshCommand(config, 'cat /etc/os-release || uname -a');
    report(1, 'success', '操作系统探测完成', osRes.stdout.slice(0, 200));

    // 步骤 3: 检查 Node.js 环境
    report(2, 'running', '正在检查 Node.js 是否已安装...');
    const nodeCheck = await execSshCommand(config, 'which node && node -v');
    let hasNode = nodeCheck.code === 0 && nodeCheck.stdout.includes('v');
    let nodeVer = nodeCheck.stdout.trim();

    if (hasNode) {
      report(2, 'success', `已检测到现有 Node.js 环境: ${nodeVer}`);
      report(3, 'success', `跳过安装，直接使用现有 Node.js (${nodeVer})`);
    } else {
      report(2, 'running', '未检测到 Node.js，准备自动化安装 Node.js LTS (v22 / v20)...');
      report(3, 'running', '正在下载并部署预编译 Node.js LTS 独立运行包 (支持全 Linux 发行版与国内加速)...');

      // 极致高兼容性 Node.js 自动部署脚本：
      // 1. 优先使用官方/淘宝镜像预编译静态 Tarball（无视系统包管理器锁定、无视源缺失、5-10秒极速完成）
      // 2. 备用使用系统包管理器 (apt/dnf/yum/apk/pacman)
      // 3. 备用使用 NVM
      const installNodeCmd = `
        set -e
        ARCH=$(uname -m)
        case "$ARCH" in
          x86_64|amd64) NODE_ARCH="x64" ;;
          aarch64|arm64) NODE_ARCH="arm64" ;;
          armv7l) NODE_ARCH="armv7l" ;;
          *) NODE_ARCH="x64" ;;
        esac

        SUDO=""
        if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
          SUDO="sudo"
        fi

        NODE_VER="v22.14.0"
        TAR_NAME="node-\${NODE_VER}-linux-\${NODE_ARCH}.tar.xz"
        OFFICIAL_URL="https://nodejs.org/dist/\${NODE_VER}/\${TAR_NAME}"
        MIRROR_URL="https://npmmirror.com/mirrors/node/\${NODE_VER}/\${TAR_NAME}"

        echo "=== 正在下载预编译 Node.js (\${NODE_ARCH}) ==="
        DOWNLOADED=0

        # 安装基础解压工具 (tar, xz, curl/wget)
        if command -v apt-get >/dev/null 2>&1; then
          $SUDO apt-get update -y >/dev/null 2>&1 || true
          $SUDO apt-get install -y xz-utils curl tar ca-certificates >/dev/null 2>&1 || true
        elif command -v yum >/dev/null 2>&1; then
          $SUDO yum install -y xz curl tar ca-certificates >/dev/null 2>&1 || true
        fi

        if command -v curl >/dev/null 2>&1; then
          curl -fsSL --connect-timeout 10 "$MIRROR_URL" -o "/tmp/\${TAR_NAME}" || curl -fsSL --connect-timeout 10 "$OFFICIAL_URL" -o "/tmp/\${TAR_NAME}"
          [ -s "/tmp/\${TAR_NAME}" ] && DOWNLOADED=1
        elif command -v wget >/dev/null 2>&1; then
          wget -q -T 10 "$MIRROR_URL" -O "/tmp/\${TAR_NAME}" || wget -q -T 10 "$OFFICIAL_URL" -O "/tmp/\${TAR_NAME}"
          [ -s "/tmp/\${TAR_NAME}" ] && DOWNLOADED=1
        fi

        if [ "$DOWNLOADED" -eq 1 ]; then
          echo "=== 正在解压并配置 Node.js 运行时 ==="
          $SUDO mkdir -p /opt/node-dist
          $SUDO tar -xf "/tmp/\${TAR_NAME}" -C /opt/node-dist/ --strip-components=1
          
          if [ -x "/opt/node-dist/bin/node" ]; then
            $SUDO mkdir -p /usr/local/bin /usr/bin
            $SUDO ln -sf /opt/node-dist/bin/node /usr/local/bin/node 2>/dev/null || true
            $SUDO ln -sf /opt/node-dist/bin/npm /usr/local/bin/npm 2>/dev/null || true
            $SUDO ln -sf /opt/node-dist/bin/npx /usr/local/bin/npx 2>/dev/null || true
            $SUDO ln -sf /opt/node-dist/bin/node /usr/bin/node 2>/dev/null || true
            $SUDO ln -sf /opt/node-dist/bin/npm /usr/bin/npm 2>/dev/null || true
            $SUDO ln -sf /opt/node-dist/bin/npx /usr/bin/npx 2>/dev/null || true
            rm -f "/tmp/\${TAR_NAME}"
            echo "NODE_INSTALLED_OK: $(/opt/node-dist/bin/node -v)"
            exit 0
          fi
        fi

        echo "=== 尝试系统包管理器安装 ==="
        if command -v apt-get >/dev/null 2>&1; then
          export DEBIAN_FRONTEND=noninteractive
          $SUDO apt-get update -y
          $SUDO apt-get install -y nodejs npm || true
        elif command -v dnf >/dev/null 2>&1; then
          $SUDO dnf install -y nodejs npm || true
        elif command -v yum >/dev/null 2>&1; then
          $SUDO yum install -y nodejs npm || true
        elif command -v apk >/dev/null 2>&1; then
          $SUDO apk update && $SUDO apk add nodejs npm || true
        fi
      `;

      const installRes = await execSshCommand(config, installNodeCmd, 240000);
      const recheck = await execSshCommand(config, 'which node && node -v');
      
      if (recheck.code !== 0 || !recheck.stdout.includes('v')) {
        const errorDetail = installRes.stderr || installRes.stdout || 'Node.js 无法在远端执行';
        report(3, 'failed', `Node.js 自动安装失败：${errorDetail.slice(0, 300)}`, errorDetail);
        return { 
          ok: false, 
          token, 
          daemonPort, 
          error: `远端 Node.js 安装失败: ${errorDetail.slice(0, 200)}` 
        };
      }
      hasNode = true;
      nodeVer = recheck.stdout.trim();
      report(3, 'success', `Node.js 运行时已部署就绪: ${nodeVer}`);
    }

    // 步骤 4: 下发守护脚本
    report(4, 'running', '正在部署 HAP 守护进程脚本到远端...');
    const daemonScriptContent = generateRemoteDaemonScript({ port: daemonPort, token });
    const b64Content = Buffer.from(daemonScriptContent, 'utf-8').toString('base64');

    const deployCmd = `
      SUDO=""
      if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
      fi
      $SUDO mkdir -p /opt/hap-daemon
      echo "${b64Content}" | base64 -d | $SUDO tee /opt/hap-daemon/daemon.mjs >/dev/null
      $SUDO chmod +x /opt/hap-daemon/daemon.mjs
    `;
    const deployRes = await execSshCommand(config, deployCmd);
    if (deployRes.code !== 0) {
      report(4, 'failed', '写入守护进程脚本失败', deployRes.stderr);
      return { ok: false, token, daemonPort, error: deployRes.stderr };
    }
    report(4, 'success', '守护进程脚本已成功部署至 /opt/hap-daemon/daemon.mjs');

    // 步骤 5: 配置并启动服务 (systemd / nohup)
    report(5, 'running', '正在配置 systemd 自启动守护服务...');
    const systemdService = `
[Unit]
Description=HAP Remote Agent Daemon
After=network.target

[Service]
Type=simple
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/opt/node-dist/bin:$PATH
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node /opt/hap-daemon/daemon.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
    `.trim();

    const b64Service = Buffer.from(systemdService, 'utf-8').toString('base64');
    const startServiceCmd = `
      SUDO=""
      if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
      fi

      NODE_BIN=$(which node || echo "/opt/node-dist/bin/node")
      if [ -x "$NODE_BIN" ]; then
        $SUDO ln -sf "$NODE_BIN" /usr/local/bin/node 2>/dev/null || true
      fi

      if command -v systemctl >/dev/null 2>&1; then
        echo "${b64Service}" | base64 -d | $SUDO tee /etc/systemd/system/hap-daemon.service >/dev/null
        $SUDO systemctl daemon-reload
        $SUDO systemctl enable hap-daemon
        $SUDO systemctl restart hap-daemon
      else
        $SUDO pkill -f "/opt/hap-daemon/daemon.mjs" || true
        nohup "$NODE_BIN" /opt/hap-daemon/daemon.mjs > /opt/hap-daemon/daemon.log 2>&1 &
      fi
    `;

    const startRes = await execSshCommand(config, startServiceCmd);
    if (startRes.code !== 0) {
      report(5, 'failed', '启动服务失败', startRes.stderr);
      return { ok: false, token, daemonPort, error: startRes.stderr };
    }
    report(5, 'success', '守护服务已启动并设置开机自启');

    // 步骤 6: 健康校验与通信打通
    report(6, 'running', `正在验证远端通信端口 (${daemonPort}) 存活状态...`);
    // 给服务 2 秒启动缓冲
    await new Promise(r => setTimeout(r, 2000));

    const verifyCmd = `curl -s -f http://127.0.0.1:${daemonPort}/health || wget -qO- http://127.0.0.1:${daemonPort}/health || echo "HEALTH_CHECK_FAIL"`;
    const verifyRes = await execSshCommand(config, verifyCmd);

    if (verifyRes.stdout.includes('HEALTH_CHECK_FAIL')) {
      report(6, 'failed', '守护进程未能正常响应健康检查请求', verifyRes.stdout);
      return { ok: false, token, daemonPort, error: '远端服务健康检查未通过 (端口响应异常)' };
    }

    report(6, 'success', `守护进程已成功上线！通信 Token 与端口 (${daemonPort}) 握手完毕`);

    return {
      ok: true,
      token,
      daemonPort,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    report(totalSteps - 1, 'failed', `安装过程异常: ${errMsg}`);
    return { ok: false, token, daemonPort, error: errMsg };
  }
}
