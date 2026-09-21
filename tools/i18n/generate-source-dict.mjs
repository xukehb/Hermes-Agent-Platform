#!/usr/bin/env node
/**
 * 生成 src/gui/renderer/i18n-source-en.js
 *
 * 输入：
 *   tools/i18n/source-en.json   —— 中文原文 -> 英文译文（人工维护）
 *
 * 输出：
 *   源文案词典 SOURCE_TEXT_EN 与带插值的正则规则 SOURCE_TEXT_PATTERNS
 *
 * 用法：
 *   node tools/i18n/generate-source-dict.mjs            # 写入
 *   node tools/i18n/generate-source-dict.mjs --check    # 仅校验是否已是最新
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = join(ROOT, 'src', 'gui', 'renderer');
const DICT_PATH = join(ROOT, 'tools', 'i18n', 'source-en.json');
const OUT_PATH = join(SRC_DIR, 'i18n-source-en.js');

const CJK = /[\u4e00-\u9fff]/;

// 少量模板逐段直译会读起来别扭，这里给出整句式覆盖（键为生成出的正则源串）
const PATTERN_OVERRIDES = new Map([
  ['^已从项目文件(.+?)载入规范文档$', 'Loaded the convention from the project file: $1'],
  ['^已生成(.+?)注入预览$', 'Generated an injection preview for $1'],
  ['^已成功写入同步到(.+?)$', 'Synced to $1'],
  ['^(.+?)详细进程列表$', '$1 process list'],
  ['^已激活 AI 生图插件（技能：(.+?)）$', 'AI image plugin activated (skill: $1)'],
  ['^完善(.+?)项目开发文档与规范说明$', 'Improve documentation and conventions in $1'],
  ['^补充与完善(.+?)单元测试用例$', 'Extend and refine unit tests in $1'],
  ['^优化(.+?)界面布局样式与视觉质感$', 'Optimize layout and visual polish in $1'],
  ['^调整(.+?)项目依赖版本与构建配置$', 'Adjust dependencies and build configuration in $1'],
  ['^重构与优化(.+?)界面交互与视图状态逻辑$', 'Rework UI interaction and view state in $1'],
  ['^完善(.+?)节点诊断与服务通讯协议$', 'Improve node diagnostics and service protocol in $1'],
  ['^增强(.+?)核心智能体调度与执行安全$', 'Strengthen agent scheduling and execution safety in $1'],
  ['^更新(.+?)业务功能实现$', 'Update business logic in $1'],
  ['^已将(.+?)设为系统默认主模型$', 'Set $1 as the system default model'],
  ['^技能(.+?)已成功卸载$', 'Skill $1 uninstalled'],
  ['^插件(.+?)保存成功$', 'Plugin $1 saved'],
  ['^项目(.+?)添加成功$', 'Project $1 added'],
]);

const dict = JSON.parse(readFileSync(DICT_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// 从 app.js 的模板字符串推导带插值的正则规则
//   `${expr}` -> 捕获组, `<tag>` -> 分段（渲染后是独立文本节点）
// ---------------------------------------------------------------------------
function buildPatterns(appSource) {
  const collapse = (s) => s.replace(/\s+/g, ' ');
  const SHORT_UNIT = /^[a-z]{1,3}$/;
  const startsWord = (t) => Boolean(t) && /^[A-Za-z0-9]/.test(t) && !SHORT_UNIT.test(t);
  const endsWord = (t) => Boolean(t) && /[A-Za-z0-9]$/.test(t) && !/\$\d+$/.test(t);

  const patterns = new Map();
  const re = /`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(appSource))) {
    const raw = m[0]
      .slice(1, -1)
      .replace(/\\n/g, ' ')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`');
    const marked = raw
      .replace(/\$\{[^{}]*\}|\$\{[^}]*\}/g, '\u0001')
      .replace(/<[^>]*>/g, '\u0002');

    for (const seg of marked.split('\u0002')) {
      if (!seg.includes('\u0001')) continue;
      if (!CJK.test(seg.replace(/\u0001/g, ''))) continue;

      // 保留片段自身的首尾空白：DOM 渲染后插值两侧的空格会原样保留，
      // 直接丢弃会导致正则吞掉空格、替换时又补一个，形成双空格。
      const parts = seg.split('\u0001').map(collapse);
      const trans = parts.map((rawPart) => {
        const t = rawPart.trim();
        if (!t) return '';
        return CJK.test(t) ? dict[t] : t;
      });
      if (trans.some((t) => t === undefined)) continue;

      // 逐片段拼装正则与替换文本：源片段自身的首尾空白决定插值两侧是否留空格，
      // 译文一律先 trim，避免与源片段空白叠加成双空格。
      const PUNCT_LEAD = /^[,.;:!?)\]]/;
      let src = '^';
      let repl = '';
      let group = 1;
      const addSpace = (nextText) => {
        if (/\s$/.test(repl)) return;
        if (PUNCT_LEAD.test(nextText || '')) return;
        repl += ' ';
      };
      parts.forEach((rawPart, i) => {
        const trimmed = rawPart.trim();
        const isLast = i === parts.length - 1;
        if (i > 0) {
          src += '(.+?)';
          repl += '$' + group++;
          // 前导空白位于插值之后：正则与替换文本都要保留，否则惰性捕获组会吃掉空格
          if (/^\s/.test(rawPart)) {
            src += ' ';
            addSpace(trans[i]);
          } else if (endsWord(repl) && startsWord(trans[i])) {
            addSpace(trans[i]);
          }
        }
        src += escapeRegex(trimmed);
        repl += trans[i];
        // 尾随空白位于下一个插值之前
        if (!isLast && /\s$/.test(rawPart)) {
          src += ' ';
          // 源码里该片段后紧跟一个插值，空格属于「插值之前」，必须在译文里保留。
          // 之前按 trans[i + 1] 判断，遇到紧邻的收尾标点（如 PID: 1)）会误删这个空格。
          if (!/\s$/.test(repl)) repl += ' ';
        }
      });
      // normalizeSourceText 已对文本节点做过去空白处理，因此正则首尾不应带空格
      src = (src + '$').replace(/^\^ /, '^').replace(/ \$$/, '$');
      if (src.length > 300) continue;
      try {
        new RegExp(src);
      } catch {
        continue;
      }
      const rule = PATTERN_OVERRIDES.get(src) || repl.trim();
      patterns.set(src, rule);
    }
  }
  // 按字面量长度倒序排列：更具体的规则先匹配，避免
  // `^(.+?)核心$` 抢先命中本应由 `^(.+?)逻辑核心$` 处理的文案。
  // 手工规则在最后应用，允许修正自动推导出的不理想结果
  for (const [src, repl] of EXTRA_PATTERNS) {
    patterns.set(src.source, repl);
  }
  const literalWeight = (src) => src.replace(/^\^|\$$/g, '').replace(/\(\?\.\+\?\)/g, '').length;
  return [...patterns.entries()].sort((a, b) => literalWeight(b[0]) - literalWeight(a[0]));
}

/**
 * 正则字面量转义
 * @param {string} value
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const esc = (s) =>
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');

/**
 * 词典键与运行时文本保持一致。
 *
 * source-en.json 是人工维护的，键里可能残留 HTML 实体（如 \&#10; 表示换行）。
 * 但 DOM 会把实体解码成真实字符，且 i18n.js 的 normalizeSourceText 会把连续
 * 空白折叠为单个空格。若不在这里做同样的归一化，像多行 placeholder 这类文案
 * 永远匹配不上，界面就会残留中文。
 */
function normalizeDictKey(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 归一化后去重：同义键（如 "&lt;x&gt;" 与 "<x>"）只保留一条。
 * 冲突时优先保留「本来就已归一化」的那条，因为它才与 DOM 解码后的运行时文本一致。
 */
function buildNormalizedEntries(source) {
  const merged = new Map();
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizeDictKey(key);
    if (!normalized) continue;
    const alreadyNormalized = normalized === key;
    const existing = merged.get(normalized);
    if (existing === undefined) merged.set(normalized, { value, alreadyNormalized });
    else if (alreadyNormalized && !existing.alreadyNormalized) {
      merged.set(normalized, { value, alreadyNormalized });
    } else if (!alreadyNormalized && !existing.alreadyNormalized && existing.value !== value) {
      console.warn(`[i18n] 归一化后键冲突且译文不同: ${JSON.stringify(key)} -> ${JSON.stringify(normalized)}`);
    }
  }
  return new Map([...merged].map(([k, v]) => [k, v.value]));
}

/**
 * 手工维护的补充规则。
 *
 * 有些文案由主进程拼接后传入渲染层（例如 ip-lookup 返回的「局域网内网 (IP)」），
 * app.js 里没有对应的模板字符串，生成器推导不出规则。这类文案数量很少且格式稳定，
 * 直接在此登记，避免把「规则推导」扩展成不可维护的启发式。
 */
// 注意：这里必须写字面 emoji，RegExp#source 不能保留 \u{..} 转义，
// 而生成器输出的正则不带 u 标志，转义会退化成字面量 "u{1F3E0}" 导致规则永不命中。
const EXTRA_PATTERNS = [
  [/^🏠 局域网内网 \((.+?)\)$/, '🏠 LAN address ($1)'],
  [/^🏠 局域网内网地址 \((.+?)\)$/, '🏠 LAN address ($1)'],
  [/^🌐 公网 IP \((.+?)\)$/, '🌐 Public IP ($1)'],
  [/^一键强制结束此进程 \(PID: (.+?)\)$/, 'Force-kill this process (PID: $1)'],
];

const appSource = readFileSync(join(SRC_DIR, 'app.js'), 'utf8');
const patterns = buildPatterns(appSource);
const normalizedDict = buildNormalizedEntries(dict);
const keys = [...normalizedDict.keys()].sort();

const out = [
  '/**',
  ' * 源文案英文字典 (Source text -> English)',
  ' *',
  ' * 本平台绝大多数文案既包含未标注的静态文本，也包含 app.js 运行时注入的模板',
  ' * 字符串，无法全部用 data-i18n 属性覆盖。这里以「中文原文 -> 英文译文」的方式',
  ' * 提供第二层翻译：凡文本节点内容与词典键完全一致，即替换为译文。',
  ' *',
  ' * SOURCE_TEXT_PATTERNS 处理带插值的模板，例如「共 3 个文件变更」。',
  ' *',
  ' * 本文件由 tools/i18n/generate-source-dict.mjs 生成，请勿手工编辑。',
  ' */',
  '(function () {',
  "  'use strict';",
  '',
  '  var SOURCE_TEXT_EN = {',
  ...keys.map((k, i) => `    '${esc(k)}': '${esc(normalizedDict.get(k))}'${i === keys.length - 1 ? '' : ','}`),
  '  };',
  '',
  '  var SOURCE_TEXT_PATTERNS = [',
  ...patterns.map(
    ([s, r], i) => `    [/${s.replace(/\//g, '\\/')}/, '${esc(r)}']${i === patterns.length - 1 ? '' : ','}`,
  ),
  '  ];',
  '',
  '  globalThis.HAP_SOURCE_TEXT_EN = SOURCE_TEXT_EN;',
  '  globalThis.HAP_SOURCE_TEXT_PATTERNS = SOURCE_TEXT_PATTERNS;',
  '})();',
  '',
].join('\n');

const check = process.argv.includes('--check');
if (check) {
  let current = '';
  try {
    current = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error('缺少 i18n-source-en.js，请先运行 node tools/i18n/generate-source-dict.mjs');
    process.exit(1);
  }
  if (current !== out) {
    console.error('i18n-source-en.js 与 source-en.json 不一致，请重新生成。');
    process.exit(1);
  }
  console.log(`源文案词典已是最新（${keys.length} 条词典 + ${patterns.length} 条规则）`);
} else {
  writeFileSync(OUT_PATH, out);
  console.log(`已生成 i18n-source-en.js（${keys.length} 条词典 + ${patterns.length} 条规则）`);
}
