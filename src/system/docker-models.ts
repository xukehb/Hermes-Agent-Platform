export type DockerEngine = 'whisper' | 'qwen-audio' | 'cosyvoice' | 'flux' | 'sd3' | 'sdxl' | 'cogvideo' | 'hunyuan';
export interface DockerModelRecipe {
  id: string;
  repo: string;
  runtimeRepo: string;
  engine: DockerEngine;
  kind: 'audio' | 'image' | 'video';
  container: string;
  image: string;
  port: number;
  minMemoryGB: number;
  minDiskGB: number;
  minVramGB: number;
  requiresGpu: boolean;
}
export interface DockerHostInfo {
  architecture: string;
  memoryGB: number;
  gpu: boolean;
  vramGB?: number;
}
const definitions: [string, string, DockerEngine, number, number, number, number][] = [
  ['whisper:large-v3', 'openai/whisper-large-v3', 'whisper', 8201, 8, 15, 0],
  ['whisper:base', 'openai/whisper-base', 'whisper', 8202, 2, 10, 0],
  ['qwen2-audio:7b', 'Qwen/Qwen2-Audio-7B-Instruct', 'qwen-audio', 8203, 24, 30, 16],
  ['cosyvoice:latest', 'FunAudioLLM/CosyVoice-300M', 'cosyvoice', 8204, 8, 20, 4],
  ['flux-schnell', 'black-forest-labs/FLUX.1-schnell', 'flux', 8211, 32, 45, 12],
  ['stable-diffusion-3.5:medium', 'stabilityai/stable-diffusion-3.5-medium', 'sd3', 8212, 24, 30, 8],
  ['sdxl-turbo', 'stabilityai/sdxl-turbo', 'sdxl', 8213, 16, 20, 8],
  ['cogvideox:5b', 'THUDM/CogVideoX-5b', 'cogvideo', 8221, 32, 40, 16],
  ['hunyuan-video:latest', 'tencent/HunyuanVideo', 'hunyuan', 8222, 64, 100, 24],
];
export const DOCKER_MODELS: DockerModelRecipe[] = definitions.map(([id, repo, engine, port, minMemoryGB, minDiskGB, minVramGB]) => ({
  id, repo, runtimeRepo: engine === 'hunyuan' ? 'hunyuanvideo-community/HunyuanVideo' : repo,
  engine, kind: port < 8210 ? 'audio' : port < 8220 ? 'image' : 'video',
  container: `hap-model-${port}`, image: `hap-inference-${engine === 'cosyvoice' ? 'cosyvoice' : 'standard'}:1`,
  port, minMemoryGB, minDiskGB, minVramGB, requiresGpu: minVramGB > 0,
}));
export function getDockerRecipe(id: string): DockerModelRecipe {
  const model = DOCKER_MODELS.find(m => m.id === id || m.repo === id);
  if (!model) throw new Error(`没有 Docker 部署规格：${id}`);
  return model;
}
export function dockerRunArgs(recipe: DockerModelRecipe): string[] {
  const args = ['run', '-d', '--name', recipe.container, '--label', `hap.model=${recipe.id}`, '--restart', 'unless-stopped',
    '-p', `127.0.0.1:${recipe.port}:8000`, '-v', `${recipe.container}-cache:/cache`,
    '-e', 'HF_HOME=/cache/huggingface', '-e', `MODEL_ID=${recipe.repo}`, '-e', `MODEL_REPO=${recipe.runtimeRepo}`,
    '-e', `MODEL_ENGINE=${recipe.engine}`, '--shm-size', '2g'];
  if (recipe.requiresGpu) args.push('--gpus', 'all');
  args.push(recipe.image);
  return args;
}
export function validateDockerHost(recipe: DockerModelRecipe, host: DockerHostInfo): string[] {
  const errors: string[] = [];
  if (host.memoryGB < recipe.minMemoryGB) errors.push(`Docker 至少需要 ${recipe.minMemoryGB} GB 内存，当前 ${host.memoryGB.toFixed(1)} GB`);
  if (recipe.requiresGpu && !host.gpu) errors.push('需要 NVIDIA GPU 和 NVIDIA Container Toolkit；macOS Docker 不支持 Apple GPU');
  if (recipe.requiresGpu && !['x86_64', 'amd64'].includes(host.architecture)) errors.push('当前 GPU 运行镜像要求 x86_64 Docker 主机');
  if (recipe.requiresGpu && host.vramGB !== undefined && host.vramGB < recipe.minVramGB) errors.push(`至少需要 ${recipe.minVramGB} GB 单卡显存，当前 ${host.vramGB.toFixed(1)} GB`);
  return errors;
}
