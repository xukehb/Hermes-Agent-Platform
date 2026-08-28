import { normalizeVector } from './vector-math.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * 轻量本地确定性语义 N-Gram 密集嵌入生成器 (64 维)。
 * 保证无网络、无外部 Key 下依然具备稳健的语义相似度计算能力。
 */
export class LocalSemanticEmbedder implements EmbeddingProvider {
  private readonly dimensions: number;

  constructor(dimensions: number = 64) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const clean = text.toLowerCase().trim();
    if (!clean) return new Array(this.dimensions).fill(0);

    const vec = new Array<number>(this.dimensions).fill(0);

    // 1. 词与字符 N-Gram 哈希投影 (Feature Hashing)
    const tokens = clean.split(/[\s,.;:!?/\\(){}[\]"'`~@#$%^&*+=<>_-]+/);
    for (const token of tokens) {
      if (!token) continue;
      this.hashIntoVector(token, vec, 1.2);
    }

    // 2. 双字 N-Gram 连续序列 (对中文分词与英文短语具有优良相似度匹配)
    for (let i = 0; i < clean.length - 1; i++) {
      const bi = clean.slice(i, i + 2);
      this.hashIntoVector(bi, vec, 0.8);
    }

    // 3. 归一化为单位向量
    return normalizeVector(vec);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private hashIntoVector(str: string, vec: number[], weight: number): void {
    let h1 = 0x811c9dc5;
    let h2 = 0x5bd1e995;

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      h1 ^= code;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= code;
      h2 = Math.imul(h2, 0x5bd1e995);
    }

    const idx1 = Math.abs(h1) % this.dimensions;
    const idx2 = Math.abs(h2) % this.dimensions;
    const sign = h1 % 2 === 0 ? 1 : -1;

    vec[idx1] = (vec[idx1] ?? 0) + sign * weight;
    vec[idx2] = (vec[idx2] ?? 0) + weight * 0.5;
  }
}
