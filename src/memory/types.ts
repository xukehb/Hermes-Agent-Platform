/**
 * 向量长期记忆库与 RAG 进化系统类型定义。
 */

export type MemoryCategory = 'preference' | 'fact' | 'case' | 'architecture' | 'convention' | 'domain' | 'custom';
export type MemoryLayer = 'working' | 'semantic' | 'episodic';

export interface MemoryCard {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  embedding?: number[] | undefined;
  embeddingVersion?: string | undefined;
  layer: MemoryLayer;
  agentId?: string | undefined;
  sourceTaskId?: string | undefined;
  workspace?: string | undefined;
  importance: number;
  confidence: number;
  expiresAt?: number | undefined;
  dedupeKey?: string | undefined;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt?: number | undefined;
}

export interface MemorySearchResult {
  memory: MemoryCard;
  score: number; // 0.0 ~ 1.0 (余弦相似度)
}

export interface MemoryQuery {
  text: string;
  category?: MemoryCategory | undefined;
  workspace?: string | undefined;
  limit?: number | undefined;
  threshold?: number | undefined;
  agentId?: string | undefined;
  layer?: MemoryLayer | undefined;
}

export interface MemoryState {
  memories: MemoryCard[];
}
