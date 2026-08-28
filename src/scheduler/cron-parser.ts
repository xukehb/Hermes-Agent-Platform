/**
 * 标准 5 位 Cron 表达式解析与匹配器。
 * 格式: [分钟 0-59] [小时 0-23] [日期 1-31] [月份 1-12] [星期 0-6 (0=周日)]
 */

function matchField(cronPart: string, value: number): boolean {
  const part = cronPart.trim();
  if (part === '*') return true;

  // 处理 step: */5
  if (part.startsWith('*/')) {
    const step = parseInt(part.slice(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // 处理列表: 1,5,10
  if (part.includes(',')) {
    const items = part.split(',').map((x) => parseInt(x.trim(), 10));
    return items.includes(value);
  }

  // 处理范围: 1-5
  if (part.includes('-')) {
    const [startStr, endStr] = part.split('-');
    const start = parseInt(startStr?.trim() ?? '', 10);
    const end = parseInt(endStr?.trim() ?? '', 10);
    return !isNaN(start) && !isNaN(end) && value >= start && value <= end;
  }

  // 单值匹配
  const num = parseInt(part, 10);
  return num === value;
}

export function isCronMatch(cronStr: string, date: Date = new Date()): boolean {
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dayOfWeek = date.getDay(); // 0-6

  const [mPart, hPart, domPart, monPart, dowPart] = parts;
  if (!mPart || !hPart || !domPart || !monPart || !dowPart) return false;

  return (
    matchField(mPart, minute) &&
    matchField(hPart, hour) &&
    matchField(domPart, dayOfMonth) &&
    matchField(monPart, month) &&
    matchField(dowPart, dayOfWeek)
  );
}

export function describeCron(cronStr: string): string {
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;

  const [m, h, dom, mon, dow] = parts;

  if (m?.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每隔 ${m.slice(2)} 分钟执行一次`;
  }
  if (m === '0' && h?.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return `每隔 ${h.slice(2)} 小时整点执行一次`;
  }
  if (dom === '*' && mon === '*' && dow === '*' && !m?.includes('*') && !h?.includes('*')) {
    return `每天 ${h?.padStart(2, '0')}:${m?.padStart(2, '0')} 执行`;
  }
  if (dom === '*' && mon === '*' && (dow === '1-5' || dow === '1,2,3,4,5') && !m?.includes('*') && !h?.includes('*')) {
    return `工作日 (周一至周五) ${h?.padStart(2, '0')}:${m?.padStart(2, '0')} 执行`;
  }
  if (dom === '*' && mon === '*' && (dow === '0,6' || dow === '6,0') && !m?.includes('*') && !h?.includes('*')) {
    return `周末 (周六与周日) ${h?.padStart(2, '0')}:${m?.padStart(2, '0')} 执行`;
  }

  return cronStr;
}
