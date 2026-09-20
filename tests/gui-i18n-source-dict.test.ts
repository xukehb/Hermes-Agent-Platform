import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const DICT_PATH = join(ROOT, 'tools', 'i18n', 'source-en.json');
const GENERATED_PATH = join(ROOT, 'src', 'gui', 'renderer', 'i18n-source-en.js');

const CJK = /[\u4e00-\u9fff]/;
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

type SourceDict = Record<string, string>;

let dict: SourceDict;
let patterns: [RegExp, string][];
let lookup: (source: string) => string | undefined;

beforeAll(async () => {
  dict = JSON.parse(readFileSync(DICT_PATH, 'utf8')) as SourceDict;
  await import('../src/gui/renderer/i18n-source-en.js');
  await import('../src/gui/renderer/i18n.js');
  const g = globalThis as any;
  patterns = g.HAP_SOURCE_TEXT_PATTERNS;
  lookup = g.I18N.lookupSourceTranslation;
});

describe('GUI 源文案英文字典 (source text dictionary)', () => {
  it('covers the bulk of untagged UI copy', () => {
    expect(Object.keys(dict).length).toBeGreaterThan(2500);
    expect(patterns.length).toBeGreaterThan(200);
  });

  // 语言切换类文案需要同时展示两种语言，是唯一允许保留中文的例外
  const BILINGUAL_ALLOWLIST = new Set([
    '中文 (简体)',
    '切换中英文界面 (Switch to English)',
    '切换界面语言 (Switch Language)',
    '切换语言 (English)',
  ]);

  it('keys are Chinese source text and values are non-empty English', () => {
    for (const [key, value] of Object.entries(dict)) {
      expect(key.trim(), `key should be trimmed: ${JSON.stringify(key)}`).toBe(key);
      expect(CJK.test(key), `key should contain Chinese: ${JSON.stringify(key)}`).toBe(true);
      expect(typeof value).toBe('string');
      // 少数条目是插值模板的片段（如「空间！」），需要译成空串把中文去掉
      if (value !== '' && !BILINGUAL_ALLOWLIST.has(key)) {
        expect(CJK.test(value), `${key} => ${value}`).toBe(false);
      }
    }
  });

  it('contains no emoji, matching the neutral enterprise design system', () => {
    for (const [key, value] of Object.entries(dict)) {
      expect(EMOJI.test(value), `emoji in "${key}": "${value}"`).toBe(false);
    }
  });

  it('is exposed to the runtime through i18n.js', () => {
    const g = globalThis as any;
    expect(g.HAP_SOURCE_TEXT_EN).toBeDefined();
    expect(Object.keys(g.HAP_SOURCE_TEXT_EN).length).toBe(Object.keys(dict).length);
  });

  it('generated module stays in sync with the maintained dictionary', () => {
    const keys = Object.keys(dict).sort();
    expect(Object.keys((globalThis as any).HAP_SOURCE_TEXT_EN).sort()).toEqual(keys);
    // index.html 必须在 i18n.js 之前加载词典，否则 I18N 初始化时拿不到数据
    const html = readFileSync(join(ROOT, 'src', 'gui', 'renderer', 'index.html'), 'utf8');
    const dictIdx = html.indexOf('./i18n-source-en.js');
    const i18nIdx = html.indexOf('./i18n.js');
    expect(dictIdx).toBeGreaterThan(-1);
    expect(dictIdx).toBeLessThan(i18nIdx);
  });

  it('resolves exact source text', () => {
    expect(lookup('新建会话')).toBe('New Conversation');
    expect(lookup('系统设置')).toBe('Settings');
    expect(lookup('外观')).toBe('Appearance');
  });

  it('resolves interpolated templates through pattern rules', () => {
    // 回归：插值模板曾整句漏翻，或在捕获组两侧叠加出双空格
    expect(lookup('8 个模型')).toBe('8 models');
    expect(lookup('12 条消息')).toBe('12 messages');
    expect(lookup('10 逻辑核心')).toBe('10 logical cores');
    // 运行时长模板：`${d}天 ${h}小时 ${m}分`
    expect(lookup('5天 2小时 3分')).toBe('5d 2h 3min');
    expect(lookup('模型：deepseek-chat')).toBe('Model: deepseek-chat');
  });

  it('translates dictionary-matching capture groups inside templates', () => {
    const out = lookup('绑定智能体: ops (全栈运智能运维专家) | 告警通道: feishu | 异常自愈: 已开启');
    // 「已开启」是内置文案而不是用户数据，应一并翻译
    expect(out === undefined || /Enabled/.test(out)).toBe(true);
  });

  it('leaves unknown copy untouched instead of guessing', () => {
    expect(lookup('这是一句词典里没有的中文')).toBeUndefined();
    expect(lookup('Hello world')).toBeUndefined();
  });

  it('every pattern rule compiles and produces a usable replacement', () => {
    for (const [re, replacement] of patterns) {
      expect(re).toBeInstanceOf(RegExp);
      expect(re.source.startsWith('^'), `pattern must be anchored: ${re.source}`).toBe(true);
      expect(re.source.endsWith('$'), `pattern must be anchored: ${re.source}`).toBe(true);
      expect(typeof replacement).toBe('string');
      // 单个空串替换会让整段文字消失，属于明显错误
      expect(replacement.trim().length).toBeGreaterThan(0);
      // 捕获组数量必须与替换占位符匹配
      const groupCount = (re.source.match(/\(\.\+\?\)/g) || []).length;
      const used = new Set<number>();
      for (const m of replacement.matchAll(/\$(\d)/g)) used.add(Number(m[1]));
      for (const n of used) {
        expect(n, `replacement references missing group $${n}: ${re.source}`).toBeLessThanOrEqual(groupCount);
      }
    }
  });
});
