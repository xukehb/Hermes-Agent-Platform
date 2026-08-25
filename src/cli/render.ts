/**
 * CLI 输出渲染（FR-CLI-*）。
 *
 * 终端输出统一在这里成型：命令实现只负责取数据，不拼字符串，
 * 这样表格宽度、列顺序、空值占位这些细节只有一处需要维护。
 *
 * 日期：2026-08-24  执行者：Codex
 */

/** 简易等宽表格。列宽按内容自适应，超宽列不换行（终端自己折行更符合直觉）。 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return '（无数据）';
  }
  const widths = headers.map((header, index) => {
    let max = displayWidth(header);
    for (const row of rows) {
      max = Math.max(max, displayWidth(row[index] ?? ''));
    }
    return max;
  });
  const lines: string[] = [];
  lines.push(headers.map((header, index) => pad(header, widths[index] ?? 0)).join('  '));
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    lines.push(headers.map((_, index) => pad(row[index] ?? '', widths[index] ?? 0)).join('  '));
  }
  return lines.join('\n');
}

/** 键值清单，用于 show 这类单对象展示。 */
export function renderPairs(pairs: readonly (readonly [string, string])[]): string {
  const width = pairs.reduce((max, [key]) => Math.max(max, displayWidth(key)), 0);
  return pairs.map(([key, value]) => pad(key, width) + '  ' + value).join('\n');
}

/**
 * 计算显示宽度：CJK 字符占两列。
 * 不做这层换算的话，中文列会明显错位。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f)
  );
}

function pad(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

/** 布尔值的可读表示。 */
export function yesNo(value: boolean): string {
  return value ? '是' : '否';
}

/** 空值占位。 */
export function orDash(value: string | number | undefined): string {
  if (value === undefined) {
    return '-';
  }
  const text = String(value);
  return text.length === 0 ? '-' : text;
}
