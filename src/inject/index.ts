import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ResolvedModel, ResolvedProvider } from '../config/index.js';

export type InjectionTarget = 'codex' | 'claude' | 'gemini' | 'grok' | 'openclaw';

export interface InjectionInput {
  target: InjectionTarget;
  model: ResolvedModel;
  provider: ResolvedProvider;
  env: Record<string, string | undefined>;
  home?: string;
}

export interface InjectionPlan {
  target: InjectionTarget;
  model: string;
  baseUrl: string;
  apiKeyEnv: string | undefined;
  configPath: string;
  environment: Record<string, string>;
  files: Array<{ path: string; content: string }>;
}

function apiKey(input: InjectionInput): string | undefined {
  return input.provider.envKey === undefined ? undefined : input.env[input.provider.envKey];
}

function home(input: InjectionInput): string {
  return input.home ?? homedir();
}

function jsonFile(path: string, current: Record<string, unknown>, settings: Record<string, string>): { path: string; content: string } {
  const next = { ...current, env: { ...((current.env as Record<string, unknown> | undefined) ?? {}), ...settings } };
  return { path, content: JSON.stringify(next, null, 2) + '\n' };
}

export function planInjection(input: InjectionInput): InjectionPlan {
  const key = apiKey(input);
  const environment: Record<string, string> = {};
  if (input.provider.envKey !== undefined && key !== undefined) environment[input.provider.envKey] = key;

  if (input.target === 'claude') {
    environment.ANTHROPIC_BASE_URL = input.provider.baseUrl;
    environment.ANTHROPIC_MODEL = input.model.model;
    if (key !== undefined) environment.ANTHROPIC_API_KEY = key;
    const path = join(home(input), '.claude', 'settings.json');
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
    return { target: input.target, model: input.model.model, baseUrl: input.provider.baseUrl, apiKeyEnv: input.provider.envKey, configPath: path, environment, files: [jsonFile(path, current, { ANTHROPIC_BASE_URL: input.provider.baseUrl, ANTHROPIC_MODEL: input.model.model })] };
  }

  if (input.target === 'gemini') {
    environment.GEMINI_MODEL = input.model.model;
    environment.GEMINI_API_KEY = key ?? '';
    environment.GOOGLE_GEMINI_BASE_URL = input.provider.baseUrl;
    const path = join(home(input), '.gemini', 'settings.json');
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
    return { target: input.target, model: input.model.model, baseUrl: input.provider.baseUrl, apiKeyEnv: input.provider.envKey, configPath: path, environment, files: [jsonFile(path, current, { GEMINI_MODEL: input.model.model, GOOGLE_GEMINI_BASE_URL: input.provider.baseUrl })] };
  }

  if (input.target === 'grok') {
    environment.XAI_API_KEY = key ?? '';
    environment.XAI_MODEL = input.model.model;
    environment.XAI_BASE_URL = input.provider.baseUrl;
    const path = join(home(input), '.grok', 'config.json');
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
    return { target: input.target, model: input.model.model, baseUrl: input.provider.baseUrl, apiKeyEnv: input.provider.envKey, configPath: path, environment, files: [jsonFile(path, current, environment)] };
  }

  if (input.target === 'openclaw') {
    environment.OPENCLAW_API_KEY = key ?? '';
    environment.OPENCLAW_MODEL = input.model.model;
    environment.OPENCLAW_BASE_URL = input.provider.baseUrl;
    const path = join(home(input), '.openclaw', 'settings.json');
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
    return { target: input.target, model: input.model.model, baseUrl: input.provider.baseUrl, apiKeyEnv: input.provider.envKey, configPath: path, environment, files: [jsonFile(path, current, environment)] };
  }

  environment.CODEX_MODEL = input.model.model;
  environment.CODEX_API_KEY = key ?? '';
  environment.CODEX_BASE_URL = input.provider.baseUrl;
  const path = join(home(input), '.codex', 'config.toml');
  const content = ['model = "' + input.model.model + '"', 'model_provider = "hap"', '', '[model_providers.hap]', 'name = "' + input.provider.name + '"', 'base_url = "' + input.provider.baseUrl + '"', ...(input.provider.envKey === undefined ? [] : ['env_key = "' + input.provider.envKey + '"']), ''].join('\n');
  return { target: input.target, model: input.model.model, baseUrl: input.provider.baseUrl, apiKeyEnv: input.provider.envKey, configPath: path, environment, files: [{ path, content }] };
}

export function writeInjection(plan: InjectionPlan): void {
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf8');
  }
}

export function launchWithInjection(plan: InjectionPlan, command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...plan.environment }, shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
}

export function targetCommand(target: InjectionTarget): string {
  return target === 'codex' ? 'codex' : target === 'claude' ? 'claude' : target === 'gemini' ? 'gemini' : target === 'openclaw' ? 'openclaw' : 'grok';
}
