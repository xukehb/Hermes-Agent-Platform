import { describe, expect, it } from 'vitest';
import { DOCKER_MODELS, dockerRunArgs, validateDockerHost } from '../src/system/docker-models.js';

describe('Docker model recipes', () => {
  it('covers all nine external models with isolated ports and volumes', () => {
    expect(DOCKER_MODELS).toHaveLength(9);
    expect(new Set(DOCKER_MODELS.map(m => m.port)).size).toBe(9);
    for (const model of DOCKER_MODELS) {
      expect(model.repo).toContain('/');
      expect(dockerRunArgs(model)).toContain(`127.0.0.1:${model.port}:8000`);
      expect(dockerRunArgs(model)).toContain(`${model.container}-cache:/cache`);
    }
  });
  it('allows Whisper base on ARM CPU and blocks GPU models without GPU', () => {
    const host = { architecture: 'aarch64', memoryGB: 4, gpu: false };
    expect(validateDockerHost(DOCKER_MODELS[1]!, host)).toEqual([]);
    expect(validateDockerHost(DOCKER_MODELS[4]!, host).join(' ')).toMatch(/GPU/);
  });
  it('checks Docker memory, rather than assuming host memory is available', () => {
    expect(validateDockerHost(DOCKER_MODELS[0]!, { architecture: 'x86_64', memoryGB: 2, gpu: false }).join(' ')).toMatch(/内存/);
  });
});

import { vi } from 'vitest';
import { DockerDeploymentManager, type DockerCommandRunner } from '../src/system/docker-deployment.js';

function harness(health = vi.fn(async () => ({ phase: 'ready', model: 'openai/whisper-base' }))) {
  let exists = false;
  let running = false;
  const calls: string[][] = [];
  const runner: DockerCommandRunner = {
    async run(args) {
      calls.push(args);
      const key = args.join(' ');
      if (key.startsWith('context inspect')) return { stdout: 'unix:///var/run/docker.sock', stderr: '' };
      if (args[0] === 'info') return { stdout: JSON.stringify({ Architecture: 'aarch64', MemTotal: 4 * 1024 ** 3, OSType: 'linux' }), stderr: '' };
      if (key.startsWith('container inspect')) {
        if (!exists) throw new Error('No such container');
        return { stdout: JSON.stringify([{ Config: { Labels: { 'hap.model': 'whisper:base' } }, State: { Running: running, Status: running ? 'running' : 'exited' } }]), stderr: '' };
      }
      if (args[0] === 'run' && args.includes('--rm')) return { stdout: '{"disk":100,"vram":0}', stderr: '' };
      if (args[0] === 'run' && args.includes('-d')) { exists = true; running = true; }
      if (args[0] === 'stop') running = false;
      if (args[0] === 'start') running = true;
      if (args[0] === 'rm') exists = false;
      if (key.startsWith('volume inspect')) return { stdout: '[{"Labels":{"hap.model":"whisper:base"}}]', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  };
  const manager = new DockerDeploymentManager({ runner, health, sleep: async () => {}, healthAttempts: 3 });
  return { manager, calls, runner, health };
}

describe('Docker deployment lifecycle', () => {
  it('waits for model health rather than treating a running container as ready', async () => {
    const health = vi.fn().mockResolvedValueOnce({ phase: 'loading' }).mockResolvedValue({ phase: 'ready', model: 'openai/whisper-base' });
    const { manager, calls } = harness(health);
    const progress: string[] = [];
    const recipe = await manager.deploy('whisper:base', p => progress.push(p.phase));
    expect(recipe.repo).toBe('openai/whisper-base');
    expect(health).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)).toBe('ready');
    expect(calls.some(c => c[0] === 'build')).toBe(true);
  });
  it('does not start downloading a GPU model on an incompatible host', async () => {
    const { manager, calls } = harness();
    await expect(manager.deploy('flux-schnell', () => {})).rejects.toThrow('GPU');
    expect(calls.some(c => c[0] === 'build' || c[0] === 'run')).toBe(false);
  });
  it('keeps cache but stops a container whose model failed to load', async () => {
    const { manager, calls } = harness(vi.fn().mockResolvedValue({ phase: 'error', error: 'gated repository' }));
    await expect(manager.deploy('whisper:base', () => {})).rejects.toThrow('gated repository');
    expect(calls.some(c => c[0] === 'stop')).toBe(true);
    expect(calls.some(c => c[0] === 'volume' && c[1] === 'rm')).toBe(false);
  });
  it('rejects timeouts without reporting readiness', async () => {
    const { manager } = harness(vi.fn().mockResolvedValue({ phase: 'loading' }));
    const progress = vi.fn();
    await expect(manager.deploy('whisper:base', progress)).rejects.toThrow('超时');
    expect(progress.mock.calls.some(([p]) => p.phase === 'ready')).toBe(false);
  });
  it('restarts an existing deployment without rebuilding its environment', async () => {
    const { manager, calls } = harness();
    await manager.deploy('whisper:base', () => {});
    await manager.stop('whisper:base');
    calls.length = 0;
    await manager.deploy('whisper:base', () => {});
    expect(calls.some(c => c[0] === 'start')).toBe(true);
    expect(calls.some(c => c[0] === 'build')).toBe(false);
  });
  it('deletes cached weights only when explicitly requested', async () => {
    const { manager, calls } = harness();
    await manager.deploy('whisper:base', () => {});
    await manager.remove('whisper:base', false);
    expect(calls.some(c => c[0] === 'volume' && c[1] === 'rm')).toBe(false);
    await manager.remove('whisper:base', true);
    expect(calls.some(c => c[0] === 'volume' && c[1] === 'rm')).toBe(true);
  });
  it('never removes a container with a mismatched ownership label', async () => {
    const { manager, runner, calls } = harness();
    const original = runner.run.bind(runner);
    runner.run = async (args, options) => args[0] === 'container' ? { stdout: '[{"Config":{"Labels":{"hap.model":"other"}},"State":{"Running":true}}]', stderr: '' } : original(args, options);
    await expect(manager.deploy('whisper:base', () => {})).rejects.toThrow('占用');
    expect(calls.some(c => c[0] === 'rm' || c[0] === 'stop')).toBe(false);
  });
  it('rejects unknown IDs before executing Docker', async () => {
    const { manager, calls } = harness();
    await expect(manager.deploy('bad;echo unsafe', () => {})).rejects.toThrow('规格');
    expect(calls).toEqual([]);
  });
});

it('restarts a live container after its previous model load failed', async () => {
  const { runner, calls } = harness();
  const original = runner.run.bind(runner);
  let restarted = false;
  runner.run = async (args, options) => {
    if (args[0] === 'container') return { stdout: JSON.stringify([{ Config: { Labels: { 'hap.model': 'whisper:base' } }, State: { Running: true, Status: 'running' } }]), stderr: '' };
    if (args[0] === 'restart') restarted = true;
    return original(args, options);
  };
  const probe = new DockerDeploymentManager({ runner, health: async () => restarted ? { phase: 'ready' } : { phase: 'error', error: 'previous failure' }, sleep: async () => {}, healthAttempts: 2 });
  await probe.deploy('whisper:base', () => {});
  expect(calls.some(c => c[0] === 'restart')).toBe(true);
});
