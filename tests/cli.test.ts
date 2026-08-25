/**
 * CLI 命令测试（FR-CLI-001 ~ FR-CLI-012）。
 *
 * 策略：
 * - 用 buildProgram().parseAsync 在进程内执行命令，不起子进程，避免 tsx 冷启动开销。
 * - 劫持 process.stdout.write 收集输出，finally 与 afterEach 双重还原。
 * - 全程离线：不调 provider check / model import，doctor 一律带 --skip-network。
 * - 不触碰常驻命令（serve / chat），它们会阻塞测试进程。
 * - 每例后把 process.exitCode 复位，防止 fail() 的副作用污染 vitest 退出码。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildProgram, main } from '../src/cli/index.js';
import { CliExit } from '../src/cli/context.js';
import { ConfigResolver, loadConfig } from '../src/config/index.js';

// ── 临时工作目录：所有写入都落在这里，测试结束整棵删掉 ─────────

const root = mkdtempSync(join(tmpdir(), 'hap-cli-'));
const configPath = join(root, 'hap.toml');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── stdout 劫持 ───────────────────────────────────────────────

let captured: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);

function startCapture(): void {
  captured = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
}

function stopCapture(): void {
  process.stdout.write = origWrite;
}

// ── 命令执行辅助 ──────────────────────────────────────────────

/** 执行一条命令并返回 stdout 文本；命令内部 fail() 时抛错，交给 runFail。 */
async function run(...args: string[]): Promise<string> {
  startCapture();
  try {
    await buildProgram().parseAsync(['node', 'hap', '-c', configPath, ...args]);
  } finally {
    stopCapture();
  }
  return captured.join('');
}

/** 执行一条预期失败的命令，返回 CliExit 的消息。 */
async function runFail(...args: string[]): Promise<string> {
  startCapture();
  let caught: unknown;
  try {
    await buildProgram().parseAsync(['node', 'hap', '-c', configPath, ...args]);
  } catch (error) {
    caught = error;
  } finally {
    stopCapture();
  }
  if (!(caught instanceof CliExit)) {
    throw new Error('期望 CliExit，实际：' + String(caught));
  }
  process.exitCode = 0;
  return caught.message;
}

/** 从磁盘读回配置并解析，用于断言写操作真的落盘了。 */
function reread(): ConfigResolver {
  return new ConfigResolver(loadConfig({ path: configPath, env: {} }), {}, {});
}

afterEach(() => {
  stopCapture();
  captured = [];
  process.exitCode = 0;
});

// ═══════════════════════════════════════════════════════════════
// 1. init
// ═══════════════════════════════════════════════════════════════

describe('hap init', () => {
  it('写入骨架：8 家服务商、9 个模型、5 个智能体', async () => {
    const out = await run('init');
    expect(out).toContain('写入配置骨架');
    expect(existsSync(configPath)).toBe(true);

    const resolver = reread();
    expect(resolver.resolveProviders().size).toBe(8);
    expect(resolver.resolveModels().size).toBe(9);
    expect(resolver.resolveAllAgents()).toHaveLength(5);
    expect(resolver.resolveDefaultAgentId()).toBe('coder');
  });

  it('重复 init 抛 CONFIG_CONFLICT（配置文件已存在）', async () => {
    let caught: unknown;
    try {
      await run('init');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('已存在');
  });

  it('--force 覆盖已有配置', async () => {
    const out = await run('init', '--force');
    expect(out).toContain('写入配置骨架');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. config 子命令
// ═══════════════════════════════════════════════════════════════

describe('hap config', () => {
  it('path 打印生效的配置文件路径', async () => {
    const out = await run('config', 'path');
    expect(out).toContain(configPath);
  });

  it('keys 列出可解析键（含 default_agent 与 paths.data_dir）', async () => {
    const out = await run('config', 'keys');
    expect(out).toContain('default_agent');
    expect(out).toContain('paths.data_dir');
  });

  it('limits 打印生效配额（含 maxIterations）', async () => {
    const out = await run('config', 'limits');
    expect(out).toContain('maxIterations');
    expect(out).toContain('24');
  });

  it('channels 打印三个通道的状态', async () => {
    const out = await run('config', 'channels');
    expect(out).toContain('Telegram');
    expect(out).toContain('HTTP');
    expect(out).toContain('CLI');
  });

  it('explain default_agent 展示六层候选与胜出层', async () => {
    const out = await run('config', 'explain', 'default_agent');
    expect(out).toContain('胜出层');
    expect(out).toContain('coder');
  });

  it('--json explain 输出结构化结果', async () => {
    const out = await run('--json', 'config', 'explain', 'model', '-a', 'coder');
    const data = JSON.parse(out) as { key: string; agentId?: string; winner: string; candidates: unknown[] };
    expect(data.key).toBe('model.primary');
    expect(data.agentId).toBe('coder');
    expect(typeof data.winner).toBe('string');
    expect(Array.isArray(data.candidates)).toBe(true);
    expect(data.candidates.length).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. provider 子命令（对齐 ocx 的运行时加服务商能力）
// ═══════════════════════════════════════════════════════════════

describe('hap provider', () => {
  it('presets 列出 8 家内置预置', async () => {
    const out = await run('provider', 'presets');
    expect(out).toContain('deepseek');
    expect(out).toContain('anthropic');
    expect(out).toContain('ollama');
  });

  it('list 展示已配置服务商及凭据/引用两列', async () => {
    const out = await run('provider', 'list');
    expect(out).toContain('deepseek');
    expect(out).toContain('openai');
    expect(out).toContain('BASE URL');
  });

  it('add 用预置继承线制与协议，仅覆盖 base_url', async () => {
    const out = await run('provider', 'add', 'mycorp', '--preset', 'deepseek', '--base-url', 'https://gw.example.com/v1');
    expect(out).toContain('mycorp');

    const provider = reread().resolveProvider('mycorp');
    expect(provider.baseUrl).toBe('https://gw.example.com/v1');
    expect(provider.wireApi).toBe('chat');
    expect(provider.defaultProtocol).toBe('deepseek');
  });

  it('add 支持自定义请求头与输出上限', async () => {
    await run(
      'provider', 'add', 'hdrcorp',
      '--base-url', 'https://hdr.example.com/v1',
      '--env-key', 'HDR_KEY',
      '--wire-api', 'chat',
      '--protocol', 'openai-tools',
      '--header', 'X-Title=HAP',
      '--env-header', 'X-Trace=HDR_TRACE',
      '--max-tokens-default', '4096',
    );
    const provider = reread().resolveProvider('hdrcorp');
    expect(provider.envKey).toBe('HDR_KEY');
    expect(provider.httpHeaders['X-Title']).toBe('HAP');
    expect(provider.envHttpHeaders['X-Trace']).toBe('HDR_TRACE');
    expect(provider.maxTokensDefault).toBe(4096);
  });

  it('add 缺 base_url 且无同名预置时报错', async () => {
    let caught: unknown;
    try {
      // 必须至少给一个选项，否则 provider add 会进入 @clack 交互问答并挂住测试进程
      await run('provider', 'add', 'nobaseurl', '--env-key', 'NOBASE_KEY');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('base-url');
  });

  it('add 非法 --wire-api 被拒', async () => {
    const message = await runFail('provider', 'add', 'badwire', '--base-url', 'https://x.local', '--wire-api', 'bogus');
    expect(message).toContain('bogus');
  });

  it('add 非法 --protocol 被拒', async () => {
    const message = await runFail('provider', 'add', 'badproto', '--base-url', 'https://x.local', '--protocol', 'nope');
    expect(message).toContain('nope');
  });

  it('add 非法 --header 形式被拒', async () => {
    const message = await runFail('provider', 'add', 'badhdr', '--base-url', 'https://x.local', '--header', 'novalue');
    expect(message).toContain('novalue');
  });

  it('remove 连同其下模型一起清理', async () => {
    await run('provider', 'add', 'tmpcorp', '--preset', 'ollama', '--base-url', 'http://127.0.0.1:9/v1');
    await run('model', 'add', 'tmpcorp-m', '--provider', 'tmpcorp', '--model', 'x');
    expect(reread().resolveModels().has('tmpcorp-m')).toBe(true);

    const out = await run('provider', 'remove', 'tmpcorp');
    expect(out).toContain('tmpcorp');

    const after = reread();
    expect([...after.resolveProviders().keys()]).not.toContain('tmpcorp');
    expect(after.resolveModels().has('tmpcorp-m')).toBe(false);
  });

  it('remove 不存在的服务商抛 PROVIDER_NOT_FOUND', async () => {
    let caught: unknown;
    try {
      await run('provider', 'remove', 'ghost');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('ghost');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. model 子命令
// ═══════════════════════════════════════════════════════════════

describe('hap model', () => {
  it('presets 列出内置模型目录', async () => {
    const out = await run('model', 'presets');
    expect(out).toContain('deepseek-chat');
    expect(out).toContain('claude-sonnet-4-5');
  });

  it('list 展示别名与全名', async () => {
    const out = await run('model', 'list');
    expect(out).toContain('deepseek-chat');
    expect(out).toContain('deepseek/deepseek-chat');
  });

  it('list --provider 只显示该服务商下的模型', async () => {
    const out = await run('model', 'list', '--provider', 'anthropic');
    expect(out).toContain('claude-sonnet-4-5');
    expect(out).not.toContain('deepseek/deepseek-chat');
  });

  it('add 写入窗口、输出上限、能力与参数', async () => {
    const out = await run(
      'model', 'add', 'gw-chat',
      '--provider', 'mycorp',
      '--model', 'deepseek-chat',
      '--context-window', '65536',
      '--max-output-tokens', '8192',
      '--capability', 'tools', '--capability', 'streaming',
      '--protocol', 'deepseek',
      '--param', 'temperature=0.3',
    );
    expect(out).toContain('gw-chat');

    const model = reread().resolveModels().get('gw-chat');
    expect(model).toBeDefined();
    expect(model!.providerId).toBe('mycorp');
    expect(model!.contextWindow).toBe(65536);
    expect(model!.maxOutputTokens).toBe(8192);
    expect(model!.capabilities).toEqual(['tools', 'streaming']);
    expect(model!.protocol).toBe('deepseek');
    expect(model!.params['temperature']).toBe(0.3);
  });

  it('add 省略 --model 时用别名作为真实模型名', async () => {
    await run('model', 'add', 'deepseek-chat-2', '--provider', 'deepseek');
    const model = reread().resolveModels().get('deepseek-chat-2');
    expect(model!.model).toBe('deepseek-chat-2');
  });

  it('add 非法能力标签被拒', async () => {
    const message = await runFail('model', 'add', 'badcap', '--provider', 'deepseek', '--capability', 'telepathy');
    expect(message).toContain('telepathy');
  });

  it('add 指向未声明服务商时给出可执行修复提示', async () => {
    let caught: unknown;
    try {
      await run('model', 'add', 'orphan', '--provider', 'nosuchprovider', '--model', 'x');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('hap provider add nosuchprovider');
  });

  it('remove 后模型消失', async () => {
    await run('model', 'remove', 'deepseek-chat-2');
    expect(reread().resolveModels().has('deepseek-chat-2')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. agent 子命令
// ═══════════════════════════════════════════════════════════════

/**
 * 把 paths 与 agents.defaults 的目录改到临时目录。
 *
 * 直接文本追加会撞上骨架里已有的 [agents.defaults] 表头（smol-toml 会报重复表），
 * 因此解析成对象后改字段再整体回写——这也顺带验证了配置文件的往返一致性。
 */
function redirectDirsToTmp(): void {
  const config = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config['paths'] = { data_dir: join(root, 'data') };
  const agents = (config['agents'] ?? {}) as Record<string, unknown>;
  const defaults = (agents['defaults'] ?? {}) as Record<string, unknown>;
  defaults['workspace_root'] = join(root, 'ws');
  defaults['agent_dir_root'] = join(root, 'agentdirs');
  agents['defaults'] = defaults;
  config['agents'] = agents;
  writeFileSync(configPath, stringifyToml(config) + '\n', 'utf8');
}

describe('hap agent', () => {
  beforeAll(() => {
    redirectDirsToTmp();
  });

  it('templates 列出 6 个内置模板', async () => {
    const out = await run('agent', 'templates');
    expect(out).toContain('coder');
    expect(out).toContain('researcher');
    expect(out).toContain('reviewer');
    expect(out).toContain('writer');
    expect(out).toContain('ops');
    expect(out).toContain('vision');
  });

  it('list 展示 5 个骨架智能体及其主模型', async () => {
    const out = await run('agent', 'list');
    expect(out).toContain('coder');
    expect(out).toContain('ops');
    expect(out).toContain('claude-sonnet-4-5');
  });

  it('show 展示单个智能体的完整解析结果', async () => {
    const out = await run('agent', 'show', 'coder');
    expect(out).toContain('主模型');
    expect(out).toContain('工具档位');
    expect(out).toContain('状态目录');
    expect(out).toContain(join(root, 'agentdirs'));
  });

  it('show 不存在的 id 时列出可用项', async () => {
    const message = await runFail('agent', 'show', 'nosuchagent');
    expect(message).toContain('nosuchagent');
    expect(message).toContain('coder');
  });

  it('create 基于模板生成，并用 --model 覆盖主模型', async () => {
    const out = await run(
      'agent', 'create', 'qa',
      '--template', 'reviewer',
      '--model', 'deepseek/deepseek-chat',
      '--name', 'QA 审查员',
      '--emoji', '🔍',
    );
    expect(out).toContain('qa');

    const agent = reread().resolveAllAgents().find((item) => item.id === 'qa');
    expect(agent).toBeDefined();
    expect(agent!.model.primary).toBe('deepseek/deepseek-chat');
    expect(agent!.identity.emoji).toBe('🔍');
    // reviewer 模板的 deny 名单应当继承下来
    expect(agent!.tools.deny).toContain('shell');
  });

  it('create --prompt 落盘 system.md 并回填 system_prompt_file', async () => {
    await run(
      'agent', 'create', 'promptbot',
      '--model', 'deepseek/deepseek-chat',
      '--name', '提示测试',
      '--tools-profile', 'minimal',
      '--prompt', '你只回答与配置有关的问题。',
    );
    const agent = reread().resolveAllAgents().find((item) => item.id === 'promptbot');
    expect(agent).toBeDefined();
    expect(agent!.systemPromptFile).toBeDefined();
    expect(existsSync(agent!.systemPromptFile!)).toBe(true);
    expect(readFileSync(agent!.systemPromptFile!, 'utf8')).toContain('只回答与配置有关');
  });

  it('create 重复 id 抛 CONFIG_CONFLICT', async () => {
    let caught: unknown;
    try {
      await run('agent', 'create', 'qa', '--model', 'deepseek/deepseek-chat', '--name', 'dup');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('已存在');
  });

  it('create 非法工具档位被拒', async () => {
    const message = await runFail('agent', 'create', 'badprofile', '--model', 'deepseek/deepseek-chat', '--tools-profile', 'ultra');
    expect(message).toContain('ultra');
  });

  it('create 非法运行模式被拒', async () => {
    const message = await runFail('agent', 'create', 'badmode', '--model', 'deepseek/deepseek-chat', '--name', 'x', '--mode', 'daemon');
    expect(message).toContain('daemon');
  });

  it('create 未知工具名被拒', async () => {
    const message = await runFail(
      'agent', 'create', 'badtool',
      '--model', 'deepseek/deepseek-chat', '--name', 'x',
      '--deny-tool', 'launch_missiles',
    );
    expect(message).toContain('launch_missiles');
  });

  it('update 修改名称与参数', async () => {
    const out = await run('agent', 'update', 'qa', '--name', 'QA Bot', '--param', 'temperature=0.1');
    expect(out).toContain('QA Bot');

    const agent = reread().resolveAllAgents().find((item) => item.id === 'qa');
    expect(agent!.name).toBe('QA Bot');
    expect(agent!.params['temperature']).toBe(0.1);
  });

  it('update 不带任何字段时给出可读提示', async () => {
    const message = await runFail('agent', 'update', 'qa');
    expect(message).toContain('没有给出');
  });

  it('update 不存在的 id 抛 AGENT_NOT_FOUND', async () => {
    let caught: unknown;
    try {
      await run('agent', 'update', 'nosuchagent', '--name', 'x');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('nosuchagent');
  });

  it('remove 只删配置条目，保留目录', async () => {
    const before = reread().resolveAllAgents().find((item) => item.id === 'qa');
    expect(before).toBeDefined();
    const agentDir = before!.agentDir;

    const out = await run('agent', 'remove', 'qa');
    expect(out).toContain('可手动清理');

    expect(reread().resolveAllAgents().find((item) => item.id === 'qa')).toBeUndefined();
    expect(existsSync(agentDir)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. doctor（离线）
// ═══════════════════════════════════════════════════════════════

describe('hap doctor --skip-network', () => {
  it('报告可解析智能体数量与缺失凭据，不发起网络探测', async () => {
    const out = await run('doctor', '--skip-network');
    expect(out).toContain('个智能体可解析');
    expect(out).toMatch(/凭据|环境变量/);
    // 未设置任何 Key 的环境下必然报告问题，但不应出现连通性行
    expect(out).not.toContain('ms，');
    process.exitCode = 0;
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. ops 命令（离线，走 SQLite）
// ═══════════════════════════════════════════════════════════════

describe('hap 运维命令', () => {
  it('status 对空会话返回可读状态', async () => {
    const out = await run('status');
    expect(out.length).toBeGreaterThan(0);
  });

  it('trace 查不到任务时提示', async () => {
    const message = await runFail('trace', 'no-such-task');
    expect(message).toContain('no-such-task');
  });

  it('stop 对无任务会话给出明确回执', async () => {
    const out = await run('stop', 'cli:coder');
    expect(out).toContain('没有正在执行的任务');
  });

  it('usage 无数据时也返回表头或空提示', async () => {
    const out = await run('usage', '-d', '1');
    expect(out.length).toBeGreaterThan(0);
  });

  it('prune 返回清理条数', async () => {
    const out = await run('prune', '-d', '1');
    expect(out).toContain('已清理');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. main() 的异常翻译
// ═══════════════════════════════════════════════════════════════

describe('main() 异常翻译', () => {
  it('HapError 被翻译成 ✗ [code] 文本并置 exitCode=1', async () => {
    const errors: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      errors.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    startCapture();
    try {
      await main(['node', 'hap', '-c', configPath, 'model', 'add', 'orphan2', '--provider', 'ghostprovider', '--model', 'x']);
    } finally {
      stopCapture();
      process.stderr.write = origErr;
    }
    const text = errors.join('');
    expect(text).toContain('✗ [');
    expect(text).toContain('PROVIDER_NOT_FOUND');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('CliExit 被静默吞掉，不向外抛', async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
    startCapture();
    try {
      await expect(main(['node', 'hap', '-c', configPath, 'agent', 'show', 'ghostagent'])).resolves.toBeUndefined();
    } finally {
      stopCapture();
      process.stderr.write = origErr;
    }
    process.exitCode = 0;
  });
});
