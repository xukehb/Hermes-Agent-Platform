// 厂商适配实测（执行者：Codex，日期：2026-08-24）
// 目的：验证单一 openai SDK 客户端可通过换 base_url 覆盖 DeepSeek/GLM/Gemini/OpenAI 四家，
//      并确认 Anthropic SDK 的工具 schema 字段名与工具结果回灌形态与 OpenAI 线制不同。
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const PROVIDERS = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};

// 仅构造客户端并检查请求装配能力，不发出真实网络请求（无需 API Key）
for (const [name, baseURL] of Object.entries(PROVIDERS)) {
  const client = new OpenAI({ apiKey: 'probe-placeholder', baseURL });
  const hasChat = typeof client.chat?.completions?.create === 'function';
  const hasResponses = typeof client.responses?.create === 'function';
  console.log(`OPENAI_CLIENT ${name} baseURL=${client.baseURL} chat=${hasChat} responses=${hasResponses}`);
}

const anthropic = new Anthropic({ apiKey: 'probe-placeholder' });
console.log('ANTHROPIC_CLIENT messages=' + (typeof anthropic.messages?.create === 'function') + ' baseURL=' + anthropic.baseURL);

// 工具 schema 形态差异：OpenAI 线制用 function.parameters，Anthropic 用 input_schema
const jsonSchema = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
const openaiTool = { type: 'function', function: { name: 'shell', description: '执行命令', parameters: jsonSchema } };
const anthropicTool = { name: 'shell', description: '执行命令', input_schema: jsonSchema };
console.log('TOOL_SHAPE openai_key=' + Object.keys(openaiTool.function).join(',') + ' | anthropic_key=' + Object.keys(anthropicTool).join(','));

// 工具结果回灌形态差异：OpenAI 用独立 tool 角色，Anthropic 用 user 角色内的 tool_result 块
const openaiResultMsg = { role: 'tool', tool_call_id: 'call_1', content: 'done' };
const anthropicResultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] };
console.log('RESULT_SHAPE openai_role=' + openaiResultMsg.role + ' | anthropic_role=' + anthropicResultMsg.role + '/' + anthropicResultMsg.content[0].type);
