import { describe, expect, it } from 'vitest';
import { webSearchTool, parseDuckDuckGoHtml } from '../src/tools/builtin/web-search.js';
import { builtinTools } from '../src/tools/builtin/index.js';
import { BUILTIN_TOOL_NAMES, TOOL_PROFILES } from '../src/config/defaults.js';

describe('web_search 工具', () => {
  it('已作为内置工具注册到 BUILTIN_TOOL_NAMES 与 builtinTools', () => {
    expect(BUILTIN_TOOL_NAMES).toContain('web_search');
    const tools = builtinTools();
    const found = tools.find((t) => t.definition.name === 'web_search');
    expect(found).toBeDefined();
    expect(found?.definition.description).toContain('实时互联网搜索');
  });

  it('已纳入 standard 和 research 工具档位', () => {
    expect(TOOL_PROFILES.standard).toContain('web_search');
    expect(TOOL_PROFILES.research).toContain('web_search');
    expect(TOOL_PROFILES.full).toContain('web_search');
  });

  it('能正确从 DuckDuckGo HTML 模板提取标题、URL与摘要', () => {
    const mockHtml = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen">Node.js Official Website</a>
          </h2>
          <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen">
            Node.js is an open-source, cross-platform JavaScript runtime environment.
          </a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="https://github.com/nodejs/node">Node.js GitHub Repository</a>
          </h2>
          <a class="result__snippet" href="https://github.com/nodejs/node">
            Node.js JavaScript runtime repository on GitHub.
          </a>
        </div>
      </div>
    `;

    const results = parseDuckDuckGoHtml(mockHtml, 5);
    expect(results.length).toBe(2);
    expect(results[0]?.title).toBe('Node.js Official Website');
    expect(results[0]?.url).toBe('https://nodejs.org/en');
    expect(results[0]?.snippet).toContain('JavaScript runtime');
    expect(results[1]?.title).toBe('Node.js GitHub Repository');
    expect(results[1]?.url).toBe('https://github.com/nodejs/node');
  });

  it('入参合法性校验拦截空 query', () => {
    const validated = webSearchTool.validate!({ query: '' });
    expect(validated.ok).toBe(false);
  });
});
