import { execSync, spawn } from 'node:child_process';
import process from 'node:process';

export interface OllamaStatusResult {
  isRunning: boolean;
  isInstalled: boolean;
  version?: string | undefined;
  baseUrl: string;
  installedModels: string[];
  installCommand?: string | undefined;
  downloadUrl: string;
}

export interface OllamaPullProgress {
  modelTag: string;
  status: string;
  digest?: string | undefined;
  totalBytes: number;
  completedBytes: number;
  percent: number;
  speedBps: number;
  speedFormatted: string;
  completedFormatted: string;
  totalFormatted: string;
  done: boolean;
  error?: string | undefined;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** 格式化字节为可读字符串 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** 检查命令行中是否存在 ollama 可执行文件 */
export function isOllamaCliInstalled(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'command -v ollama';
    execSync(cmd, { timeout: 800, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 获取 Ollama CLI 版本号 */
export function getOllamaCliVersion(): string | undefined {
  try {
    const output = execSync('ollama --version', { timeout: 1000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return output.replace(/^ollama\s+version\s+is\s+/i, '').replace(/^ollama\s+version\s+/i, '');
  } catch {
    return undefined;
  }
}

/** 探测本地 Ollama 引擎状态与已下载模型 */
export async function checkOllamaStatus(customBaseUrl?: string): Promise<OllamaStatusResult> {
  const baseUrl = (customBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const isInstalled = isOllamaCliInstalled();
  const version = isInstalled ? getOllamaCliVersion() : undefined;

  let isRunning = false;
  let installedModels: string[] = [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      isRunning = true;
      const data = await res.json() as { models?: Array<{ name: string; model?: string }> };
      if (data.models && Array.isArray(data.models)) {
        installedModels = data.models.map((m) => m.name || m.model || '').filter(Boolean);
      }
    }
  } catch {
    isRunning = false;
  }

  let installCommand = '';
  let downloadUrl = 'https://ollama.com/download';
  if (process.platform === 'linux') {
    installCommand = 'curl -fsSL https://ollama.com/install.sh | sh';
    downloadUrl = 'https://ollama.com/download/linux';
  } else if (process.platform === 'darwin') {
    installCommand = 'brew install ollama';
    downloadUrl = 'https://ollama.com/download/mac';
  } else if (process.platform === 'win32') {
    installCommand = 'winget install Ollama.Ollama';
    downloadUrl = 'https://ollama.com/download/windows';
  }

  return {
    isRunning,
    isInstalled,
    version,
    baseUrl,
    installedModels,
    installCommand,
    downloadUrl,
  };
}

/**
 * 在后台尝试启动本地 Ollama 守护服务 (ollama serve)
 */
export async function startOllamaDaemon(customBaseUrl?: string): Promise<{ ok: boolean; message: string }> {
  const baseUrl = customBaseUrl || DEFAULT_BASE_URL;
  const initialCheck = await checkOllamaStatus(baseUrl);
  if (initialCheck.isRunning) {
    return { ok: true, message: 'Ollama 服务已经在运行中。' };
  }

  if (!initialCheck.isInstalled) {
    return { ok: false, message: `系统未检测到 Ollama 客户端。请先执行安装：${initialCheck.installCommand || 'https://ollama.com/download'}` };
  }

  try {
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.unref();

    // 轮询等待端口响应（最多等待 5 秒）
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const check = await checkOllamaStatus(baseUrl);
      if (check.isRunning) {
        return { ok: true, message: 'Ollama 守护进程已成功在本地拉起并监听 11434 端口！' };
      }
    }

    return { ok: false, message: '已执行 ollama serve，但在 5 秒内尚未探测到服务监听，请稍候再试或检查终端输出。' };
  } catch (err) {
    return { ok: false, message: `启动 Ollama 进程失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 流式拉取模型，并通过回调报告实时进度与网速
 */
export async function pullOllamaModelStream(
  modelTag: string,
  options: {
    baseUrl?: string;
    signal?: AbortSignal;
    onProgress: (progress: OllamaPullProgress) => void;
  }
): Promise<void> {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/api/pull`;

  let lastCompleted = 0;
  let lastTime = Date.now();
  let currentSpeedBps = 0;

  const fetchInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelTag, stream: true }),
  };
  if (options.signal) {
    fetchInit.signal = options.signal;
  }

  const res = await fetch(url, fetchInit);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama 返回 HTTP ${res.status}: ${text || res.statusText}`);
  }

  if (!res.body) {
    throw new Error('Ollama 未返回响应流');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const json = JSON.parse(trimmed) as {
            status?: string;
            digest?: string;
            total?: number;
            completed?: number;
            error?: string;
          };

          if (json.error) {
            throw new Error(json.error);
          }

          const now = Date.now();
          const dt = (now - lastTime) / 1000;
          const completed = json.completed || 0;
          const total = json.total || 0;

          if (dt >= 0.5 && completed > lastCompleted) {
            currentSpeedBps = Math.round((completed - lastCompleted) / dt);
            lastCompleted = completed;
            lastTime = now;
          }

          const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
          const isFinished = json.status === 'success';

          options.onProgress({
            modelTag,
            status: json.status || 'pulling',
            digest: json.digest,
            totalBytes: total,
            completedBytes: completed,
            percent,
            speedBps: currentSpeedBps,
            speedFormatted: currentSpeedBps > 0 ? `${formatBytes(currentSpeedBps)}/s` : '--',
            completedFormatted: formatBytes(completed),
            totalFormatted: formatBytes(total),
            done: isFinished,
          });
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message && !parseErr.message.includes('JSON')) {
            throw parseErr;
          }
        }
      }
    }

    // 最终完成通知
    options.onProgress({
      modelTag,
      status: 'success',
      totalBytes: lastCompleted,
      completedBytes: lastCompleted,
      percent: 100,
      speedBps: 0,
      speedFormatted: '0 B/s',
      completedFormatted: formatBytes(lastCompleted),
      totalFormatted: formatBytes(lastCompleted),
      done: true,
    });
  } finally {
    reader.releaseLock();
  }
}

/**
 * 删除本地已下载的 Ollama 模型
 */
export async function deleteOllamaModel(modelTag: string, customBaseUrl?: string): Promise<{ ok: boolean; message: string }> {
  const baseUrl = (customBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelTag }),
    });

    if (res.ok) {
      return { ok: true, message: `模型 ${modelTag} 已从本地存储成功删除。` };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, message: `删除失败 (HTTP ${res.status}): ${text}` };
  } catch (err) {
    return { ok: false, message: `删除模型请求异常：${err instanceof Error ? err.message : String(err)}` };
  }
}
