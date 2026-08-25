// 技术栈实测脚本（执行者：Codex，日期：2026-08-24）
// 目的：验证 zod 一库两用（运行时校验 + JSON Schema 导出）与 smol-toml 的嵌套表解析能力
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';

// 1) 同一个 schema 既校验工具入参，又导出 JSON Schema 注入 Hermes <tools> 段
const ShellArgs = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeout_ms: z.number().int().min(1).max(600000).default(30000),
  workdir: z.string().optional(),
});

const jsonSchema = z.toJSONSchema(ShellArgs, { io: 'input' });
console.log('JSON_SCHEMA=' + JSON.stringify(jsonSchema));

const bad = ShellArgs.safeParse({ command: 'ls', timeout_ms: 999999999 });
console.log('REJECT_BAD_success=' + bad.success + ' code=' + (bad.error ? bad.error.issues[0].code : 'none'));

const good = ShellArgs.safeParse({ command: 'ls' });
console.log('ACCEPT_GOOD_success=' + good.success + ' data=' + JSON.stringify(good.data));

// 2) smol-toml 解析嵌套表，验证 config.toml 能承载 model_providers 与 agents.entries
const tomlText = [
  '[model_providers.deepseek]',
  'base_url = "https://api.deepseek.com/v1"',
  'env_key = "DEEPSEEK_API_KEY"',
  'wire_api = "chat"',
  '',
  '[agents.entries.r1]',
  'model = "deepseek/deepseek-chat"',
  'tools = ["shell", "read_file"]',
  'max_turns = 24',
].join('\n');

const cfg = parseToml(tomlText);
console.log('TOML_PARSED=' + JSON.stringify(cfg));
console.log('TOML_TYPES max_turns=' + typeof cfg.agents.entries.r1.max_turns + ' tools_is_array=' + Array.isArray(cfg.agents.entries.r1.tools));
