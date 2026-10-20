import { normalizeVector } from './vector-math.js';

export interface EmbeddingProvider {
  readonly version?: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * 轻量本地确定性语义 N-Gram 密集嵌入生成器 (64 维)。
 * 保证无网络、无外部 Key 下依然具备稳健的语义相似度计算能力。
 */
export class LocalSemanticEmbedder implements EmbeddingProvider {
  readonly version = 'local-ngram-v1-64';
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

/** Ollama 本地向量模型提供者配置 */
export interface OllamaEmbeddingOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Ollama 本地向量模型提供者。
 * 连接本地部署的 Ollama 服务（如 nomic-embed-text, bge-m3, all-minilm）。
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly version: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaEmbeddingOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = options.model || process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
    this.timeoutMs = options.timeoutMs || 8000;
    this.version = `ollama-${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const clean = text.trim();
    if (!clean) return [];

    const url = `${this.baseUrl}/api/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: clean }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Ollama embedding request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error('Ollama returned invalid embedding payload');
    }

    return normalizeVector(data.embedding);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** OpenAI 兼容向量提供者配置 */
export interface OpenAiEmbeddingOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * OpenAI / 兼容端点向量模型提供者。
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly version: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiEmbeddingOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = options.model || 'text-embedding-3-small';
    this.timeoutMs = options.timeoutMs || 10000;
    this.version = `openai-${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const clean = text.trim();
    if (!clean) return [];

    const url = `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: clean }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`OpenAI embedding request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('OpenAI returned invalid embedding payload');
    }

    return normalizeVector(vec);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const cleanTexts = texts.map((t) => t.trim()).filter(Boolean);
    if (cleanTexts.length === 0) return [];

    const url = `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: cleanTexts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`OpenAI batch embedding request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    if (!Array.isArray(data.data)) {
      throw new Error('OpenAI returned invalid batch embedding payload');
    }

    return data.data.map((item) => normalizeVector(item.embedding));
  }
}

/**
 * 具有自动容错降级能力的智能 Embedding 提供者。
 * 若主模型（Ollama / OpenAI）发生网络超时、未安装或异常，自动平滑退化为本地 LocalSemanticEmbedder。
 */
export class SmartFallbackEmbeddingProvider implements EmbeddingProvider {
  readonly version: string;
  private readonly primary: EmbeddingProvider;
  private readonly fallback: LocalSemanticEmbedder;
  private primaryFailed = false;

  constructor(primary: EmbeddingProvider, fallback: LocalSemanticEmbedder = new LocalSemanticEmbedder()) {
    this.primary = primary;
    this.fallback = fallback;
    this.version = primary.version || fallback.version;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.embed(text);
      } catch {
        this.primaryFailed = true;
      }
    }
    return this.fallback.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.embedBatch(texts);
      } catch {
        this.primaryFailed = true;
      }
    }
    return this.fallback.embedBatch(texts);
  }
}

/**
 * 创建智能自适应向量提供者。
 */
export function createDefaultEmbeddingProvider(options?: {
  ollama?: OllamaEmbeddingOptions;
  openai?: OpenAiEmbeddingOptions;
}): EmbeddingProvider {
  if (options?.ollama || process.env.OLLAMA_EMBED_MODEL) {
    return new SmartFallbackEmbeddingProvider(new OllamaEmbeddingProvider(options?.ollama));
  }
  if (options?.openai || (process.env.OPENAI_API_KEY && process.env.OPENAI_EMBED_MODEL)) {
    return new SmartFallbackEmbeddingProvider(new OpenAiEmbeddingProvider(options?.openai));
  }
  return new LocalSemanticEmbedder();
}

