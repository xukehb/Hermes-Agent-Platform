/**
 * 高性能向量数学运算工具集。
 */

export function dotProduct(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

export function magnitude(a: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

export function normalizeVector(a: number[]): number[] {
  const mag = magnitude(a);
  if (mag === 0) return a.slice();
  return a.map((v) => v / mag);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  const dot = dotProduct(a, b);
  const sim = dot / (magA * magB);
  // 限制浮点精度在 -1 到 1 之间
  return Math.max(-1, Math.min(1, sim));
}
