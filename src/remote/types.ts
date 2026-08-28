export type AuthType = 'password' | 'privateKey';

export interface RemoteSystemInfo {
  hostname: string;
  platform: string; // linux, darwin, win32
  arch: string; // x64, arm64
  osRelease: string;
  uptimeSeconds: number;
  cpuCount: number;
  cpuModel: string;
  cpuUsagePercent: number;
  totalMemBytes: number;
  freeMemBytes: number;
  usedMemPercent: number;
  loadAvg: number[];
  nodeVersion?: string | undefined;
  diskFreeBytes?: number | undefined;
  diskTotalBytes?: number | undefined;
  timestamp: number;
}

export interface ServerBotConfig {
  enabled: boolean;
  agentId: string; // 绑定的专属智能体角色 (如 'ops', 'coder')
  channel: 'feishu' | 'wechat' | 'qq' | 'telegram' | 'webhook'; // 告警机器人通道类型
  webhookUrl?: string; // Webhook 地址
  targetId?: string; // 群号 / Chat ID / 接收人
  secret?: string; // 签名密钥 (如飞书安全秘钥)
  alertOnHighCpu?: boolean; // CPU > 85% 告警
  alertOnHighMem?: boolean; // 内存 > 90% 告警
  alertOnHighDisk?: boolean; // 磁盘 > 85% 告警
  alertOnOffline?: boolean; // 节点离线告警
  autoHealing?: boolean; // 异常时自动唤醒 Agent 自愈
}

export interface RemoteServerConfig {
  id: string;
  name: string;
  host: string;
  port: number; // default 22
  username: string; // default root
  authType: AuthType;
  password?: string | undefined;
  privateKey?: string | undefined;
  passphrase?: string | undefined;
  
  // Remote daemon settings
  daemonPort: number; // default 9527
  token?: string | undefined; // security token for daemon communication
  
  // Dedicated Ops Agent & Bound Bot
  agentId?: string | undefined; // e.g. 'ops', 'coder'
  boundBotId?: string | undefined; // 绑定的专属机器人实例 ID
  botConfig?: ServerBotConfig | undefined; // 节点专属机器人与告警策略配置

  // Runtime status
  status: 'online' | 'offline' | 'installing' | 'error' | 'uninstalled';
  lastConnectedAt?: number | undefined;
  lastError?: string | undefined;
  systemInfo?: RemoteSystemInfo | undefined;
  createdAt: number;
  updatedAt: number;
}

export type InstallStepId = 
  | 'ssh_connect'
  | 'check_os'
  | 'check_node'
  | 'install_node'
  | 'deploy_daemon'
  | 'setup_service'
  | 'verify_health';

export interface InstallProgressEvent {
  step: InstallStepId;
  stepIndex: number;
  totalSteps: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  message: string;
  details?: string | undefined;
  timestamp: number;
}

export interface RemoteExecResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RemoteRpcRequest {
  id: string;
  method: 'ping' | 'sysinfo' | 'exec' | 'restart' | 'stop' | 'agent_run';
  params?: Record<string, unknown> | undefined;
  token?: string | undefined;
}

export interface RemoteRpcResponse<T = unknown> {
  id: string;
  ok: boolean;
  data?: T | undefined;
  error?: string | undefined;
}
