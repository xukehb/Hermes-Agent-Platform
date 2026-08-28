/**
 * 向量长期记忆库与 RAG 进化系统类型定义。
 */

export type MemoryCategory = 'preference' | 'fact' | 'case' | 'architecture';

export interface MemoryCard {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  embedding?: number[] | undefined;
  sourceTaskId?: string | undefined;
  workspace?: string | undefined;
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
}

export interface MemoryState {
  memories: MemoryCard[];
}
