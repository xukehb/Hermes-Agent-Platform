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
