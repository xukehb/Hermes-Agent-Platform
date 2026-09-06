import { describe, expect, it } from 'vitest';
import { formatWhatsAppText } from '../src/channels/whatsapp-formatter.js';
import { formatWeChatText, formatWeComMarkdown } from '../src/channels/wechat-formatter.js';
import { formatFeishuMarkdown, buildFeishuCard } from '../src/channels/feishu-formatter.js';
import { formatQQText } from '../src/channels/qq-formatter.js';

describe('formatWhatsAppText', () => {
  it('正确将 Markdown 双星号转为 WhatsApp 单星号粗体，且处理代码块', () => {
    const input = [
      '**重要通知**',
      '请查看以下代码：',
      '```typescript',
      'const a = 1;',
      '```',
    ].join('\n');

    const result = formatWhatsAppText(input);
    expect(result).toContain('*重要通知*');
    expect(result).toContain('💻 *typescript*');
    expect(result).toContain('```\nconst a = 1;\n```');
  });

  it('将 [思考] 转换为引用块', () => {
    const input = '[思考] 第一步规划\n第二步执行';
    const result = formatWhatsAppText(input);
    expect(result).toContain('💭 *思考过程:*');
    expect(result).toContain('> 第一步规划');
    expect(result).toContain('> 第二步执行');
  });

  it('转换链接为 Title: url', () => {
    const input = '文档在 [官网](https://hap.ai)';
    const result = formatWhatsAppText(input);
    expect(result).toContain('官网: https://hap.ai');
  });

  it('转换删除线与列表', () => {
    const input = '~~旧版本~~\n- 第一项\n- 第二项';
    const result = formatWhatsAppText(input);
    expect(result).toContain('~旧版本~');
    expect(result).toContain('• 第一项');
    expect(result).toContain('• 第二项');
  });
});

describe('formatWeChatText', () => {
  it('将代码块渲染为优雅的 ASCII 线框盒', () => {
    const input = '```python\nprint("hello wechat")\n```';
    const result = formatWeChatText(input);
    expect(result).toContain('┌─ [python]');
    expect(result).toContain('│ print("hello wechat")');
    expect(result).toContain('└──────────────────────────────');
  });

  it('转换粗体为中文方括号【】且转换标题为符号', () => {
    const input = '# 每日报告\n这是 **核心指标**';
    const result = formatWeChatText(input);
    expect(result).toContain('📌 每日报告');
    expect(result).toContain('【核心指标】');
  });

  it('转换思考过程与链接', () => {
    const input = '[思考] 正在定位问题\n详情见 [链接](https://weixin.qq.com)';
    const result = formatWeChatText(input);
    expect(result).toContain('💭【思考过程】\n正在定位问题');
    expect(result).toContain('链接: https://weixin.qq.com');
  });
});

describe('formatWeComMarkdown', () => {
  it('为状态与思考过程添加企微颜色标签', () => {
    const input = [
      '⚙ coder 正在处理  ·  第 1 轮',
      '⏳ read_file (path="a.ts")',
      '✓ read_file (path="a.ts")  100ms',
      '✗ write_file (path="b.ts")',
    ].join('\n');

    const result = formatWeComMarkdown(input);
    expect(result).toContain('<font color="info">');
    expect(result).toContain('<font color="warning">');
  });
});

describe('formatFeishuMarkdown & buildFeishuCard', () => {
  it('保留代码块并高亮工具调用与状态', () => {
    const input = [
      '⚙ coder 正在处理  ·  第 1 轮',
      '⏳ read_file (path="test.ts")',
      '```json',
      '{"ok": true}',
      '```',
    ].join('\n');

    const result = formatFeishuMarkdown(input);
    expect(result).toContain('⚙️ **⚙ coder 正在处理  ·  第 1 轮**');
    expect(result).toContain('⏳ **`read_file`**');
    expect(result).toContain('```json\n{"ok": true}\n```');
  });

  it('根据执行状态动态设置卡片模板颜色与标题', () => {
    const errCard = buildFeishuCard('✗ 执行异常：找不到文件');
    expect(errCard.header.template).toBe('red');
    expect(errCard.header.title.content).toContain('异常');

    const successCard = buildFeishuCard('✅ 任务处理完成，已生成报告');
    expect(successCard.header.template).toBe('turquoise');
    expect(successCard.header.title.content).toContain('协同回执');

    const progressCard = buildFeishuCard('⚙ 智能体正在处理中...');
    expect(progressCard.header.template).toBe('indigo');
    expect(progressCard.header.title.content).toContain('处理中');

    const helpCard = buildFeishuCard('【项目与工作区】\n/project 切换');
    expect(helpCard.header.template).toBe('wathet');
    expect(helpCard.header.title.content).toContain('指令');
  });
});

describe('formatQQText', () => {
  it('代码块转为线框盒，行内代码转为中文引号', () => {
    const input = '调用 `execShell()` 函数：\n```bash\nnpm test\n```';
    const result = formatQQText(input);
    expect(result).toContain('「execShell()」');
    expect(result).toContain('┌─ [bash]');
    expect(result).toContain('│ npm test');
    expect(result).toContain('└──────────────────────────────');
  });

  it('处理标题、链接与思考过程', () => {
    const input = '# 部署通知\n请查看 [构建日志](https://ci.qq.com)\n[思考] 准备拉取镜像';
    const result = formatQQText(input);
    expect(result).toContain('📌 部署通知');
    expect(result).toContain('构建日志: https://ci.qq.com');
    expect(result).toContain('💭【思考过程】\n准备拉取镜像');
  });
});
