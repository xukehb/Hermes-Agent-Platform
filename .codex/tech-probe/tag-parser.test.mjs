// StreamTagParser 可测性验证（执行者：Codex，日期：2026-08-24）
// 目的：证明 Hermes 标签跨 chunk 断裂无法用一次性正则解决，必须增量状态机；并验证 vitest 可本地自动执行
import { describe, expect, it } from 'vitest';

// 最小增量状态机：仅用于验证方案可行性，非最终实现
function createTagParser(tagName) {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  let buffer = '';
  let inside = false;
  const completed = [];
  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        if (!inside) {
          const i = buffer.indexOf(open);
          if (i === -1) return;
          buffer = buffer.slice(i + open.length);
          inside = true;
        } else {
          const j = buffer.indexOf(close);
          if (j === -1) return;
          completed.push(buffer.slice(0, j).trim());
          buffer = buffer.slice(j + close.length);
          inside = false;
        }
      }
    },
    results: () => completed,
  };
}

describe('Hermes 标签流式解析', () => {
  it('标签在 chunk 边界被切断时仍能正确聚合', () => {
    const parser = createTagParser('tool_call');
    // 模拟真实 SSE 分片：开标签、JSON 体、闭标签全部跨 chunk 断裂
    for (const chunk of ['好的，我来执行。<tool', '_call>{"name":"sh', 'ell","arguments":{"command":"ls"}}</tool', '_call>完成。']) {
      parser.push(chunk);
    }
    expect(parser.results()).toEqual(['{"name":"shell","arguments":{"command":"ls"}}']);
    expect(JSON.parse(parser.results()[0]).name).toBe('shell');
  });

  it('单次拼接后的正则同样能匹配，但需等待流结束（证明增量解析的价值在于时延）', () => {
    const full = '<tool_call>{"name":"shell"}</tool_call>';
    expect(/<tool_call>([\s\S]*?)<\/tool_call>/.exec(full)?.[1]).toBe('{"name":"shell"}');
    // 半个标签时正则无结果，说明按 chunk 直接套正则会漏掉调用
    expect(/<tool_call>([\s\S]*?)<\/tool_call>/.exec('<tool_call>{"name":"sh')).toBeNull();
  });

  it('一轮回复内的多个工具调用应全部捕获', () => {
    const parser = createTagParser('tool_call');
    parser.push('<tool_call>{"i":1}</tool_call><tool_call>{"i":2}</tool_call>');
    expect(parser.results()).toHaveLength(2);
  });
});
