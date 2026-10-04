import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCKER_MODELS, getDockerRecipe, type DockerHostInfo, type DockerModelRecipe, dockerRunArgs, validateDockerHost } from './docker-models.js';

export interface DockerDeploymentProgress { modelId: string; phase: string; message: string }
export interface DockerRunOptions { signal?: AbortSignal; log?: (text: string) => void; env?: NodeJS.ProcessEnv; timeout?: number }
export interface DockerCommandRunner { run(args: string[], options?: DockerRunOptions): Promise<{ stdout: string; stderr: string }> }
export const dockerRunner: DockerCommandRunner = {
  run(args, options = {}) {
    return new Promise((resolve, reject) => {
      const candidates = process.platform === 'darwin'
        ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']
        : process.platform === 'win32' ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')] : ['/usr/bin/docker', '/usr/local/bin/docker'];
      const executable = candidates.find(existsSync) ?? 'docker';
      const subprocessEnv = { ...(options.env ?? process.env) };
      if (executable !== 'docker') subprocessEnv.PATH = `${dirname(executable)}${delimiter}${subprocessEnv.PATH ?? ''}`;
      const child = spawn(executable, args, { env: subprocessEnv, signal: options.signal, windowsHide: true });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Docker 命令超时')); }, options.timeout ?? 30_000);
      child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout = (stdout + text).slice(-64_000); options.log?.(text); });
      child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr = (stderr + text).slice(-64_000); options.log?.(text); });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolve({ stdout, stderr }); else reject(new Error(stderr.slice(-3000) || `Docker exited ${code}`)); });
    });
  },
};
interface ContainerInfo {
  Config: { Labels?: Record<string, string>; Env?: string[] };
  State: { Running: boolean; Status: string; Error?: string };
}
export interface DockerModelStatus { id: string; status: string; baseUrl: string; error?: string }
export interface DockerDeploymentOptions {
  runner?: DockerCommandRunner;
  health?: (recipe: DockerModelRecipe) => Promise<{ phase: string; model?: string; error?: string }>;
  sleep?: (signal: AbortSignal) => Promise<void>;
  healthAttempts?: number;
}
export class DockerDeploymentManager {
  private readonly runner: DockerCommandRunner;
  private readonly health: NonNullable<DockerDeploymentOptions['health']>;
  private readonly sleep: NonNullable<DockerDeploymentOptions['sleep']>;
  private readonly attempts: number;
  private active?: { id: string; controller: AbortController; finished: Promise<void> };
  private readonly errors = new Map<string, string>();
  constructor(options: DockerDeploymentOptions = {}) {
    this.runner = options.runner ?? dockerRunner;
    this.health = options.health ?? (async recipe => {
      const res = await fetch(`http://127.0.0.1:${recipe.port}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json() as { phase: string; model?: string; error?: string };
      if (res.ok && data.phase === 'ready' && data.model === recipe.repo) return data;
      return { phase: data.phase === 'error' ? 'error' : 'loading', error: data.error ?? '' };
    });
    this.sleep = options.sleep ?? (signal => new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('部署已取消')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 5000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }));
    this.attempts = options.healthAttempts ?? 2160; // Up to three hours for large downloads.
  }
  async host(): Promise<DockerHostInfo> {
    const endpoint = process.env.DOCKER_HOST || (await this.runner.run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
    if (!/^(unix:|npipe:|tcp:\/\/(localhost|127\.0\.0\.1)(:|\/|$))/.test(endpoint)) {
      throw new Error('当前仅支持本地 Docker daemon；请切换到本地 Docker context');
    }
    const { stdout } = await this.runner.run(['info', '--format', '{{json .}}']);
    const info = JSON.parse(stdout) as { Architecture: string; MemTotal: number; OSType: string; Runtimes?: Record<string, unknown> };
    if (info.OSType !== 'linux') throw new Error('请将 Docker 切换到 Linux containers');
    return { architecture: info.Architecture, memoryGB: info.MemTotal / 1024 ** 3, gpu: Boolean(info.Runtimes?.nvidia) };
  }
  private async inspect(recipe: DockerModelRecipe): Promise<ContainerInfo | undefined> {
    try {
      const result = await this.runner.run(['container', 'inspect', recipe.container]);
      const info = (JSON.parse(result.stdout) as ContainerInfo[])[0];
      if (info?.Config.Labels?.['hap.model'] !== recipe.id) throw new Error(`容器名 ${recipe.container} 被其他容器占用，不会覆盖`);
      return info;
    } catch (error) {
      if (/No such (object|container)/i.test(String(error))) return undefined;
      throw error;
    }
  }
  async status(): Promise<{ available: boolean; message: string; models: DockerModelStatus[]; host?: DockerHostInfo }> {
    try {
      const host = await this.host();
      if (process.platform === 'win32') host.gpu = true;
      const models = await Promise.all(DOCKER_MODELS.map(async recipe => {
        let status = 'absent';
        let error = this.errors.get(recipe.id) ?? '';
        try {
          const info = await this.inspect(recipe);
          status = info ? info.State.Status : 'absent';
          if (info?.State.Running) {
            const health = await this.health(recipe).catch(() => ({ phase: 'loading' }));
            status = health.phase;
          }
          if (this.active?.id === recipe.id) status = 'deploying';
        } catch (err) { status = 'error'; error = String(err); }
        return { id: recipe.id, status, baseUrl: `http://127.0.0.1:${recipe.port}/v1`, error };
      }));
      return { available: true, message: 'Docker 已就绪', models, host };
    } catch (err) { return { available: false, message: `Docker 不可用：${String(err)}`, models: [] }; }
  }
  async deploy(id: string, onProgress: (progress: DockerDeploymentProgress) => void, token = ''): Promise<DockerModelRecipe> {
    if (this.active) throw new Error('另一个模型正在部署，请先等待完成或取消');
    const recipe = getDockerRecipe(id);
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.active = { id: recipe.id, controller, finished };
    const signal = controller.signal;
    const report = (phase: string, message: string) => onProgress({ modelId: recipe.id, phase, message: token ? message.split(token).join('[redacted]') : message });
    let workdir: string | undefined;
    try {
      this.errors.delete(recipe.id);
      report('check', '检测 Docker、内存和 GPU 条件');
      const host = await this.host();
      // Windows Docker may expose CUDA without naming a runtime; verify in the container below.
      if (process.platform === 'win32') host.gpu = true;
      const errors = validateDockerHost(recipe, host);
      if (errors.length) throw new Error(errors.join('；'));
      const existing = await this.inspect(recipe);
      if (existing?.State.Running) {
        const health = await this.health(recipe).catch(() => ({ phase: 'loading' }));
        if (health.phase === 'ready') return recipe;
      }
      if (existing && !token) {
        report('start', '启动已有容器，复用已下载权重');
        await this.runner.run([existing.State.Running ? 'restart' : 'start', recipe.container], { signal });
      } else {
        report('build', '构建推理环境（首次需要下载依赖，可能耗时较长）');
        // Copy assets out of Electron ASAR: Docker cannot read virtual archive paths.
        workdir = mkdtempSync(join(tmpdir(), 'hap-docker-'));
        cpSync(join(dirname(fileURLToPath(import.meta.url)), 'docker-runtime'), workdir, { recursive: true });
        await this.runner.run(['build', '-t', recipe.image, '-f', join(workdir, recipe.engine === 'cosyvoice' ? 'Dockerfile.cosyvoice' : 'Dockerfile'), workdir], {
          signal, timeout: 60 * 60 * 1000, log: text => report('build', text),
        });
        await this.runner.run(['volume', 'create', '--label', `hap.model=${recipe.id}`, `${recipe.container}-cache`], { signal });
        const probe = ['run', '--rm', '-v', `${recipe.container}-cache:/cache`];
        if (recipe.requiresGpu) probe.push('--gpus', 'all');
        probe.push('--entrypoint', 'python', recipe.image, '-c', "import json,shutil,torch; print(json.dumps({'disk':shutil.disk_usage('/cache').free/1024**3,'vram':max([torch.cuda.get_device_properties(i).total_memory/1024**3 for i in range(torch.cuda.device_count())] or [0])}))");
        report('check', '检测 Docker 磁盘余量和 GPU 实际可用显存');
        const raw = (await this.runner.run(probe, { signal, timeout: 120_000 })).stdout.trim();
        const resources = JSON.parse(raw.split('\n').at(-1)!) as { disk: number; vram: number };
        if (resources.disk < recipe.minDiskGB) throw new Error(`Docker 磁盘剩余 ${resources.disk.toFixed(1)} GB，至少需要 ${recipe.minDiskGB} GB`);
        if (recipe.requiresGpu && resources.vram < recipe.minVramGB) throw new Error(`GPU 单卡显存 ${resources.vram.toFixed(1)} GB，至少需要 ${recipe.minVramGB} GB`);
        if (existing) await this.runner.run(['rm', '-f', recipe.container], { signal });
        const args = dockerRunArgs(recipe);
        if (token) args.splice(args.length - 1, 0, '-e', 'HF_TOKEN');
        report('start', `启动服务并下载权重 ${recipe.runtimeRepo}`);
        await this.runner.run(args, { signal, env: { ...process.env, ...(token ? { HF_TOKEN: token } : {}) } });
      }
      for (let attempt = 0; attempt < this.attempts; attempt++) {
        signal.throwIfAborted();
        const info = await this.inspect(recipe);
        if (!info?.State.Running) throw new Error(`容器启动失败：${await this.logs(recipe.id)}`);
        const health = await this.health(recipe).catch(() => ({ phase: 'loading', error: '' }));
        if (health.phase === 'ready') { report('ready', '模型已加载，正在注册服务商'); return recipe; }
        if (health.phase === 'error') throw new Error(health.error || '模型加载失败，请查看日志');
        report('loading', attempt % 6 === 0 ? await this.logs(recipe.id) : '正在下载权重或加载模型，请耐心等待');
        await this.sleep(signal);
      }
      throw new Error('模型加载超时，可查看日志并重试；已下载权重会保留');
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (token) message = message.split(token).join('[redacted]');
      this.errors.set(recipe.id, message);
      report('error', message);
      // Stop a failed managed container; keep cache for retry.
      const info = await this.inspect(recipe).catch(() => undefined);
      if (info?.State.Running) await this.runner.run(['stop', '-t', '5', recipe.container]).catch(() => undefined);
      throw new Error(message);
    } finally {
      if (workdir) rmSync(workdir, { recursive: true, force: true });
      delete this.active;
      finish();
    }
  }
  async stop(id: string): Promise<void> {
    const recipe = getDockerRecipe(id);
    if (this.active?.id === recipe.id) {
      const active = this.active;
      active.controller.abort();
      await active.finished;
    }
    if (await this.inspect(recipe)) await this.runner.run(['stop', '-t', '10', recipe.container]);
  }
  async remove(id: string, removeWeights = false): Promise<void> {
    const recipe = getDockerRecipe(id);
    await this.stop(id);
    if (await this.inspect(recipe)) await this.runner.run(['rm', recipe.container]);
    if (removeWeights) {
      const { stdout } = await this.runner.run(['volume', 'inspect', `${recipe.container}-cache`]);
      const volume = (JSON.parse(stdout) as { Labels?: Record<string, string> }[])[0];
      if (volume?.Labels?.['hap.model'] !== recipe.id) throw new Error('缓存卷不属于此模型，不会删除');
      await this.runner.run(['volume', 'rm', `${recipe.container}-cache`]);
    }
  }
  async logs(id: string): Promise<string> {
    const recipe = getDockerRecipe(id);
    const info = await this.inspect(recipe);
    if (!info) return '尚未创建容器';
    const result = await this.runner.run(['logs', '--tail', '30', recipe.container]);
    return (result.stdout + result.stderr).slice(-8000).replace(/hf_[A-Za-z0-9]{20,}/g, '[redacted]');
  }
}
