import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { cosineSimilarity } from './vector-math.js';
import { LocalSemanticEmbedder, type EmbeddingProvider } from './embedding.js';
import type { MemoryCard, MemoryQuery, MemorySearchResult, MemoryState } from './types.js';

const DATA_PATH = join(homedir(), '.hap', 'memories.json');

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class MemoryStore {
  private static instance: MemoryStore;
  private readonly filePath: string;
  private readonly embedder: EmbeddingProvider;

  constructor(filePath: string = DATA_PATH, embedder?: EmbeddingProvider) {
    this.filePath = filePath;
    this.embedder = embedder || new LocalSemanticEmbedder();
  }

  static getInstance(filePath?: string): MemoryStore {
    if (!MemoryStore.instance) {
      MemoryStore.instance = new MemoryStore(filePath);
    }
    return MemoryStore.instance;
  }

  load(): MemoryState {
    ensureDir(this.filePath);
    if (!existsSync(this.filePath)) {
      return { memories: [] };
    }
    try {
      const text = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(text) as Partial<MemoryState>;
      return {
        memories: Array.isArray(data.memories) ? data.memories : [],
      };
    } catch {
      return { memories: [] };
    }
  }

  save(state: MemoryState): void {
    ensureDir(this.filePath);
    writeFileSync(this.filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  listMemories(category?: string): MemoryCard[] {
    const memories = this.load().memories;
    if (category) {
      return memories.filter((m) => m.category === category);
    }
    return memories;
  }

  getMemory(id: string): MemoryCard | undefined {
    return this.load().memories.find((m) => m.id === id);
  }

  async addMemory(input: {
    category: MemoryCard['category'];
    title: string;
    content: string;
    tags?: string[] | undefined;
    workspace?: string | undefined;
    sourceTaskId?: string | undefined;
  }): Promise<MemoryCard> {
    const state = this.load();
    const now = Date.now();
    const id = `mem_${now.toString(36)}_${randomUUID().slice(0, 4)}`;

    const textToEmbed = `${input.title}\n${input.content}\n${(input.tags || []).join(' ')}`;
    const embedding = await this.embedder.embed(textToEmbed);

    const card: MemoryCard = {
      id,
      category: input.category,
      title: input.title.trim(),
      content: input.content.trim(),
      tags: input.tags || [],
      embedding,
      workspace: input.workspace?.trim(),
      sourceTaskId: input.sourceTaskId?.trim(),
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };

    state.memories.push(card);
    this.save(state);
    return card;
  }

  removeMemory(id: string): boolean {
    const state = this.load();
    const lenBefore = state.memories.length;
    state.memories = state.memories.filter((m) => m.id !== id);
    if (state.memories.length !== lenBefore) {
      this.save(state);
      return true;
    }
    return false;
  }

  async searchMemories(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const state = this.load();
    if (state.memories.length === 0 || !query.text.trim()) {
      return [];
    }

    const queryVec = await this.embedder.embed(query.text);
    const limit = query.limit ?? 5;
    const threshold = query.threshold ?? 0.15;

    let candidateMemories = state.memories;
    if (query.category) {
      candidateMemories = candidateMemories.filter((m) => m.category === query.category);
    }
    if (query.workspace) {
      candidateMemories = candidateMemories.filter((m) => !m.workspace || m.workspace === query.workspace);
    }

    const scored: MemorySearchResult[] = [];
    for (const card of candidateMemories) {
      if (!card.embedding || card.embedding.length === 0) continue;
      const score = cosineSimilarity(queryVec, card.embedding);
      if (score >= threshold) {
        scored.push({ memory: card, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    // 更新召回卡片的访问频次
    if (topResults.length > 0) {
      const now = Date.now();
      for (const res of topResults) {
        res.memory.accessCount++;
        res.memory.lastAccessedAt = now;
      }
      this.save(state);
    }

    return topResults;
  }
}
