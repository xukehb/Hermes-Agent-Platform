import { describe, expect, it } from 'vitest';
import {
  escapeTelegramHtml,
  balanceHtmlTags,
  formatTelegramHtml,
} from '../src/channels/telegram-formatter.js';

describe('escapeTelegramHtml', () => {
  it('转义 &, <, > 为 HTML 实体', () => {
    expect(escapeTelegramHtml('if (a < b && c > d)')).toBe('if (a &lt; b &amp;&amp; c &gt; d)');
  });
});

describe('balanceHtmlTags', () => {
  it('自动补齐未闭合的标签', () => {
    expect(balanceHtmlTags('<b>未闭合')).toBe('<b>未闭合</b>');
    expect(balanceHtmlTags('<b><i>嵌套未闭合')).toBe('<b><i>嵌套未闭合</i></b>');
  });

  it('已闭合标签保持原样', () => {
    expect(balanceHtmlTags('<b>已闭合</b>')).toBe('<b>已闭合</b>');
  });
});

describe('formatTelegramHtml', () => {
  it('正确渲染多行代码块并保留语言，且内部字符被转义', () => {
    const input = [
      '这是代码：',
      '```typescript',
      'const div = `<div id="test">Hello & Welcome</div>`;',
      '```',
    ].join('\n');

    const result = formatTelegramHtml(input);
    expect(result).toContain('<pre><code class="language-typescript">const div = `&lt;div id="test"&gt;Hello &amp; Welcome&lt;/div&gt;`;</code></pre>');
  });

  it('代码块无语言时正常包裹 pre code', () => {
    const input = '```\nplain text\n```';
    const result = formatTelegramHtml(input);
    expect(result).toBe('<pre><code>plain text</code></pre>');
  });

  it('未闭合的代码块自动安全闭合', () => {
    const input = '```python\nprint("hello")';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<pre><code class="language-python">print("hello")</code></pre>');
  });

  it('单行行内代码安全转义', () => {
    const input = '使用 `fetch("<url>&key=1")` 函数调用';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<code>fetch("&lt;url&gt;&amp;key=1")</code>');
  });

  it('将 [思考] 转换为 expandable blockquote', () => {
    const input = [
      '[思考] 用户想要分析日志，我需要先调用 search 工具。',
      '分析结果如下：',
    ].join('\n\n');

    const result = formatTelegramHtml(input);
    expect(result).toContain('<blockquote expandable>💭 <b>思考过程</b>\n用户想要分析日志，我需要先调用 search 工具。</blockquote>');
    expect(result).toContain('分析结果如下：');
  });

  it('将 Markdown 引用 > 转换为 blockquote', () => {
    const input = '> 第一行引用\n> 第二行引用';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<blockquote>第一行引用\n第二行引用</blockquote>');
  });

  it('转换标题为加粗', () => {
    const input = '## 功能特性\n这是详情';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<b>功能特性</b>');
  });

  it('转换粗体与斜体，且不破坏 snake_case', () => {
    const input = '这是 **粗体** 和 *斜体*，还有 user_id_test 变量';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<b>粗体</b>');
    expect(result).toContain('<i>斜体</i>');
    expect(result).toContain('user_id_test');
  });

  it('转换超链接', () => {
    const input = '访问 [Hermes 文档](https://github.com/hap) 获取更多信息';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<a href="https://github.com/hap">Hermes 文档</a>');
  });

  it('列表符优化为圆点', () => {
    const input = '- 第一项\n- 第二项';
    const result = formatTelegramHtml(input);
    expect(result).toContain('• 第一项');
    expect(result).toContain('• 第二项');
  });

  it('进度状态指示器行优化', () => {
    const lines = [
      '⚙ coder 正在处理  ·  第 1 轮',
      '⏳ read_file (path="src/index.ts")',
      '✓ read_file (path="src/index.ts")  120ms',
      '✗ write_file (path="bad")',
      '↻ deepseek-chat → claude-3-5-sonnet（超时降级）',
      '· deepseek/deepseek-chat · 1500 tokens · task-abc12345',
    ].join('\n');

    const result = formatTelegramHtml(lines);
    expect(result).toContain('<b>⚙ coder 正在处理  ·  第 1 轮</b>');
    expect(result).toContain('⏳ <code>read_file</code> (path="src/index.ts")');
    expect(result).toContain('✅ <code>read_file</code> (path="src/index.ts") <code>120ms</code>');
    expect(result).toContain('❌ <code>write_file</code> (path="bad")');
    expect(result).toContain('↻ <code>deepseek-chat</code> ➔ <code>claude-3-5-sonnet</code>（超时降级）');
    expect(result).toContain('<i>🤖 <code>deepseek/deepseek-chat</code>  •  📊 <b>1500</b> tokens  •  🆔 <code>task-abc12345</code></i>');
  });

  it('命令菜单增强', () => {
    const input = '【项目与工作区】\n/project 切换当前工程';
    const result = formatTelegramHtml(input);
    expect(result).toContain('<b>【项目与工作区】</b>');
    expect(result).toContain('<code>/project</code> 切换当前工程');
  });

  it('处理空字符串或仅空白字符', () => {
    expect(formatTelegramHtml('')).toBe('');
    expect(formatTelegramHtml('   ')).toBe('   ');
  });
});
