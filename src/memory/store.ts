import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { cosineSimilarity } from './vector-math.js';
import { LocalSemanticEmbedder, type EmbeddingProvider } from './embedding.js';
import type { MemoryCard, MemoryCategory, MemoryLayer, MemoryQuery, MemorySearchResult } from './types.js';

const DATA_PATH = join(homedir(), '.hap', 'memories.json');
const EMBEDDING_VERSION = 'local-ngram-v1-64';

export type MemoryInput = {
  category: MemoryCategory;
  title: string;
  content: string;
  tags?: string[] | undefined;
  workspace?: string | undefined;
  sourceTaskId?: string | undefined;
  agentId?: string | undefined;
  layer?: MemoryLayer | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  expiresAt?: number | undefined;
  dedupeKey?: string | undefined;
};

export type MemoryPatch = Partial<MemoryInput>;

export interface TaskMemoryInput {
  taskId: string;
  agentId: string;
  workspace?: string | undefined;
  userInput: string;
  assistantOutput: string;
  toolSummary?: string | undefined;
}

interface LegacyState { memories?: Array<Partial<MemoryCard> & { category?: string }> }

function ensureDir(filePath: string): void { mkdirSync(dirname(filePath), { recursive: true }); }
function finiteScore(value: unknown, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; }
function layerFor(category: string, explicit?: MemoryLayer): MemoryLayer { return explicit || (category === 'case' ? 'episodic' : 'semantic'); }
function normalizeCategory(category: string | undefined): MemoryCategory {
  if (category === 'preference' || category === 'fact' || category === 'case' || category === 'architecture' || category === 'convention' || category === 'domain' || category === 'custom') return category;
  return 'custom';
}
function isLegacyJson(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try { return ['{', '[', ''].includes(readFileSync(filePath, 'utf8').trimStart().slice(0, 1)); } catch { return true; }
}

/**
 * 判断一段文本是否属于已知的废弃、被污染或机械套话记忆记录。
 */
export function isCorruptedMemory(text: string): boolean {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed === '') return true;

  // 1. 系统提示词、通道指引与注入信标
  const promptKeywords = [
    '微信聊天规范',
    '专属人设指令',
    '长期记忆与偏好规范',
    '背景知识与用户长期记忆',
    'Recalled Knowledge',
    'Working Memory',
    '对方发来',
    '文件工作目录',
    '系统能力与最高权限',
    '回复语言：',
    '岗位职责：',
    '当前时间：',
    'spawn_subagent',
    '工具纪律',
    '对话历史压缩器',
    '任务标题生成器',
    'Markdown 规范文档',
    'Conventional Commits',
    '像真人朋友微信聊天一样',
    '禁止输出系统指令或调试信息',
  ];
  if (promptKeywords.some((kw) => trimmed.includes(kw))) return true;

  // 2. 机器人死板客服客套、反问反刍与机械报错
  const roboticPhrases = [
    '信息不完整',
    '确认一下你的意图',
    '确认一下您的意图',
    '需要你明确',
    '需要您明确',
    '请告诉我你需要',
    '请告诉我您需要',
    '我立刻开始',
    '我立刻开工',
    '作为一名AI',
    '作为一个AI',
    '作为人工智能',
    '大语言模型',
    '希望以上回答',
    '如果您有其他问题',
    '随时告诉我',
    '随时喊我',
    '有什么需要我帮忙',
    '需要哪个直接说',
    '好的，收到',
    '收到您的需求',
    '明白您的需求',
    '很高兴为您服务',
    '摸鱼搭子',
    '待命，需要了吱一声',
    '请提供关键词',
    '涉及的模块',
    '光有 ID 我查不到',
  ];
  if (roboticPhrases.some((phrase) => trimmed.includes(phrase))) return true;

  // 3. 运行监控指标、日志堆栈与代码占位符
  const telemetryKeywords = [
    'CPU 使用率',
    '内存使用率',
    '磁盘使用率',
    '系统负载',
    'HTTP/1.',
    'HTTP/2',
    'TypeError',
    'SyntaxError',
    'ReferenceError',
    'Error: ',
    'at process.',
    'at Module.',
  ];
  if (telemetryKeywords.some((kw) => trimmed.includes(kw))) return true;

  // 4. 会话对话前缀、数字加粗列表与模板占位符
  if (/^(我|对方|用户|助理|AI|Bot)\s*[：:]/i.test(trimmed)) return true;
  if (/^===|===$/.test(trimmed)) return true;
  if (/^#+\s/.test(trimmed)) return true;
  if (/^\d+[\.、]\s*\*\*/.test(trimmed)) return true;
  if (/<(改动细节|参数|占位符|说明).*?>/.test(trimmed)) return true;

  return false;
}

/**
 * 校验一段文本是否适合作为长期记忆候选入库。
 */
export function isCleanMemoryCandidate(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 6 || trimmed.length > 300) return false;
  if (isCorruptedMemory(trimmed)) return false;
  if (/[？\?]$/.test(trimmed)) return false;
  if (/^(请问|你能否|能否|是否需要|怎么|为什么|何时|如何)/.test(trimmed)) return false;
  if (trimmed.includes('```')) return false;
  return true;
}

/**
 * 从可能包装了通道前缀（如微信即时通讯规范等）的原始输入中提炼真实用户提问。
 */
export function extractCleanUserInput(input: string): string {
  if (!input) return '';
  let text = input;
  const match = text.match(/对方发来[：:]\s*[“"']([\s\S]*?)[”"']/);
  if (match && match[1]?.trim()) {
    text = match[1].trim();
  }
  text = text.replace(/\[(?:微信聊天规范|专属人设指令|系统提示|提示)[^\]]*\]/gs, '');
  text = text.replace(/##\s*[💡🧠].*?(?=\n\n|\n[^\s-]|$)/gs, '');
  text = text.replace(/^项目路径[：:].*$/gm, '');
  return text.trim();
}

export class MemoryStore {
  private static instance: MemoryStore | undefined;
  private readonly filePath: string;
  private readonly legacyPath: string | undefined;
  private readonly embedder: EmbeddingProvider;
  private readonly db: Database.Database;
  private writeQueue: Promise<void> = Promise.resolve();
  private queryCache = new Map<string, { time: number; results: MemorySearchResult[] }>();
  private readonly QUERY_CACHE_TTL_MS = 6000;

  constructor(filePath: string = DATA_PATH, embedder?: EmbeddingProvider) {
    ensureDir(filePath);
    this.legacyPath = extname(filePath).toLowerCase() === '.json' && isLegacyJson(filePath) ? filePath : undefined;
    this.filePath = this.legacyPath ? `${filePath}.db` : filePath;
    ensureDir(this.filePath);
    this.embedder = embedder || new LocalSemanticEmbedder();
    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, layer TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', embedding TEXT, embedding_version TEXT, agent_id TEXT, source_task_id TEXT,
      workspace TEXT, importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
      expires_at INTEGER, dedupe_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER
    ); CREATE INDEX IF NOT EXISTS idx_memories_filter ON memories(category, layer, agent_id, workspace); CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(dedupe_key);`);
    if (this.legacyPath) this.migrateLegacy(this.legacyPath);
    this.cleanCorruptedMemories();
  }

  static getInstance(filePath?: string): MemoryStore { if (!MemoryStore.instance) MemoryStore.instance = new MemoryStore(filePath); return MemoryStore.instance; }
  close(): void { this.db.close(); }

  private migrateLegacy(legacyPath: string): void {
    let parsed: LegacyState;
    try { parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as LegacyState; } catch (error) { throw new Error(`记忆 JSON 文件损坏，无法迁移：${legacyPath} (${error instanceof Error ? error.message : String(error)})`); }
    if (!Array.isArray(parsed.memories)) throw new Error(`记忆 JSON 文件格式无效：${legacyPath}`);
    const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count);
    if (count === 0 && parsed.memories.length > 0) {
      const insert = this.db.prepare(`INSERT INTO memories (id,category,layer,title,content,tags,embedding,embedding_version,agent_id,source_task_id,workspace,importance,confidence,expires_at,dedupe_key,created_at,updated_at,access_count,last_accessed_at) VALUES (@id,@category,@layer,@title,@content,@tags,@embedding,@embedding_version,@agent_id,@source_task_id,@workspace,@importance,@confidence,@expires_at,@dedupe_key,@created_at,@updated_at,@access_count,@last_accessed_at)`);
      const tx = this.db.transaction((items: typeof parsed.memories) => { for (const item of items) { const category = normalizeCategory(item.category); insert.run({
        id: String(item.id || `mem_${randomUUID()}`), category, layer: layerFor(category, item.layer), title: String(item.title || '').trim(), content: String(item.content || '').trim(),
        tags: JSON.stringify(Array.isArray(item.tags) ? item.tags : []), embedding: Array.isArray(item.embedding) ? JSON.stringify(item.embedding) : null, embedding_version: item.embeddingVersion || null,
        agent_id: item.agentId || null, source_task_id: item.sourceTaskId || null, workspace: item.workspace || null, importance: finiteScore(item.importance, 0.5), confidence: finiteScore(item.confidence, 0.7), expires_at: item.expiresAt || null, dedupe_key: item.dedupeKey || null,
        created_at: Number(item.createdAt || Date.now()), updated_at: Number(item.updatedAt || Date.now()), access_count: Number(item.accessCount || 0), last_accessed_at: item.lastAccessedAt || null,
      }); } });
      tx(parsed.memories);
    }
    try { renameSync(legacyPath, `${legacyPath}.migrated`); } catch (error) { throw new Error(`记忆迁移完成但无法保留迁移备份：${error instanceof Error ? error.message : String(error)}`); }
  }

  private rowToCard(row: Record<string, unknown>): MemoryCard {
    let tags: string[] = []; let embedding: number[] | undefined;
    try { tags = JSON.parse(String(row.tags || '[]')) as string[]; } catch { tags = []; }
    try { embedding = row.embedding ? JSON.parse(String(row.embedding)) as number[] : undefined; } catch { embedding = undefined; }
    const category = normalizeCategory(String(row.category));
    return { id: String(row.id), category, layer: layerFor(category, String(row.layer) as MemoryLayer), title: String(row.title), content: String(row.content), tags, embedding, embeddingVersion: row.embedding_version ? String(row.embedding_version) : undefined, agentId: row.agent_id ? String(row.agent_id) : undefined, sourceTaskId: row.source_task_id ? String(row.source_task_id) : undefined, workspace: row.workspace ? String(row.workspace) : undefined, importance: finiteScore(row.importance, 0.5), confidence: finiteScore(row.confidence, 0.7), expiresAt: row.expires_at === null ? undefined : Number(row.expires_at), dedupeKey: row.dedupe_key ? String(row.dedupe_key) : undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), accessCount: Number(row.access_count), lastAccessedAt: row.last_accessed_at === null ? undefined : Number(row.last_accessed_at) };
  }

  listMemories(category?: string): MemoryCard[] { const rows = category ? this.db.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC').all(category) : this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all(); return rows.map((row) => this.rowToCard(row as Record<string, unknown>)); }
  getMemory(id: string): MemoryCard | undefined { const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined; return row ? this.rowToCard(row) : undefined; }

  async addMemory(input: MemoryInput): Promise<MemoryCard> {
    const title = input.title.trim(); const content = input.content.trim(); if (!title || !content) throw new Error('记忆标题和内容不能为空');
    const tags = (input.tags || []).map((tag) => tag.trim()).filter(Boolean); const category = normalizeCategory(input.category); const now = Date.now(); const id = `mem_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
    const embedding = await this.embedder.embed(`${title}\n${content}\n${tags.join(' ')}`);
    let savedId = id;
    await this.enqueueWrite(() => {
      let existing = input.dedupeKey ? this.db.prepare('SELECT id FROM memories WHERE dedupe_key = ? LIMIT 1').get(input.dedupeKey) as { id: string } | undefined : undefined;
      if (!existing) {
        const similar = this.listMemories().find((candidate) => candidate.category === category && candidate.agentId === input.agentId && candidate.workspace === (input.workspace?.trim() || undefined) && candidate.embedding && cosineSimilarity(embedding, candidate.embedding) >= 0.92);
        if (similar) existing = { id: similar.id };
      }
      if (existing) { savedId = existing.id; this.db.prepare('UPDATE memories SET category=?,layer=?,title=?,content=?,tags=?,embedding=?,embedding_version=?,agent_id=?,source_task_id=?,workspace=?,importance=?,confidence=?,expires_at=?,updated_at=? WHERE id=?').run(category, layerFor(category, input.layer), title, content, JSON.stringify(tags), JSON.stringify(embedding), EMBEDDING_VERSION, input.agentId || null, input.sourceTaskId || null, input.workspace?.trim() || null, finiteScore(input.importance, 0.5), finiteScore(input.confidence, 0.7), input.expiresAt ?? null, now, existing.id); }
      else this.db.prepare(`INSERT INTO memories (id,category,layer,title,content,tags,embedding,embedding_version,agent_id,source_task_id,workspace,importance,confidence,expires_at,dedupe_key,created_at,updated_at,access_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(id, category, layerFor(category, input.layer), title, content, JSON.stringify(tags), JSON.stringify(embedding), EMBEDDING_VERSION, input.agentId || null, input.sourceTaskId || null, input.workspace?.trim() || null, finiteScore(input.importance, 0.5), finiteScore(input.confidence, 0.7), input.expiresAt ?? null, input.dedupeKey || null, now, now);
      this.queryCache.clear();
    });
    return this.getMemory(savedId) as MemoryCard;
  }

  private enqueueWrite(task: () => void): Promise<void> { const next = this.writeQueue.then(() => task()); this.writeQueue = next.catch(() => undefined); return next; }

  updateMemory(id: string, patch: MemoryPatch): MemoryCard | undefined {
    const current = this.getMemory(id); if (!current) return undefined;
    const title = patch.title === undefined ? current.title : patch.title.trim(); const content = patch.content === undefined ? current.content : patch.content.trim(); if (!title || !content) throw new Error('记忆标题和内容不能为空');
    const category = patch.category === undefined ? current.category : normalizeCategory(patch.category); const tags = patch.tags === undefined ? current.tags : patch.tags.map((tag) => tag.trim()).filter(Boolean);
    const expiresAt = Object.prototype.hasOwnProperty.call(patch, 'expiresAt') ? (patch.expiresAt ?? null) : (current.expiresAt ?? null);
    this.db.prepare('UPDATE memories SET category=?,layer=?,title=?,content=?,tags=?,embedding=?,embedding_version=?,agent_id=?,workspace=?,source_task_id=?,importance=?,confidence=?,expires_at=?,dedupe_key=?,updated_at=? WHERE id=?').run(category, layerFor(category, patch.layer || current.layer), title, content, JSON.stringify(tags), current.embedding ? JSON.stringify(current.embedding) : null, current.embeddingVersion || EMBEDDING_VERSION, patch.agentId === undefined ? current.agentId || null : patch.agentId || null, patch.workspace === undefined ? current.workspace || null : patch.workspace || null, patch.sourceTaskId === undefined ? current.sourceTaskId || null : patch.sourceTaskId || null, finiteScore(patch.importance, current.importance), finiteScore(patch.confidence, current.confidence), expiresAt, patch.dedupeKey === undefined ? current.dedupeKey || null : patch.dedupeKey || null, Date.now(), id);
    this.queryCache.clear();
    return this.getMemory(id);
  }

  async updateMemoryWithEmbedding(id: string, patch: MemoryPatch): Promise<MemoryCard | undefined> {
    const updated = this.updateMemory(id, patch);
    if (!updated) return undefined;
    const embedding = await this.embedder.embed(`${updated.title}\n${updated.content}\n${updated.tags.join(' ')}`);
    await this.enqueueWrite(() => {
      this.db.prepare('UPDATE memories SET embedding=?, embedding_version=?, updated_at=? WHERE id=?').run(JSON.stringify(embedding), EMBEDDING_VERSION, Date.now(), id);
      this.queryCache.clear();
    });
    return this.getMemory(id);
  }

  removeMemory(id: string): boolean {
    const ok = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
    if (ok) this.queryCache.clear();
    return ok;
  }

  async rebuildEmbeddings(): Promise<number> {
    const cards = this.listMemories();
    const vectors = await this.embedder.embedBatch(cards.map((card) => `${card.title}\n${card.content}\n${card.tags.join(' ')}`));
    const update = this.db.prepare('UPDATE memories SET embedding=?,embedding_version=?,updated_at=? WHERE id=?');
    const tx = this.db.transaction(() => cards.forEach((card, index) => update.run(JSON.stringify(vectors[index]), EMBEDDING_VERSION, Date.now(), card.id)));
    tx();
    this.queryCache.clear();
    return cards.length;
  }

  async searchMemories(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const text = query.text.trim(); if (!text) return []; const now = Date.now();
    const cacheKey = `${text}:${query.category || ''}:${query.layer || ''}:${query.agentId || ''}:${query.workspace || ''}:${query.limit || 5}:${query.threshold || 0.15}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && (now - cached.time) < this.QUERY_CACHE_TTL_MS) {
      return cached.results;
    }

    let sql = 'SELECT * FROM memories WHERE (expires_at IS NULL OR expires_at > ?)';
    const params: unknown[] = [now];
    if (query.category) {
      sql += ' AND category = ?';
      params.push(query.category);
    }
    if (query.layer) {
      sql += ' AND layer = ?';
      params.push(query.layer);
    }
    if (query.agentId) {
      sql += ' AND (agent_id IS NULL OR agent_id = ?)';
      params.push(query.agentId);
    }
    if (query.workspace) {
      sql += ' AND (workspace IS NULL OR workspace = ?)';
      params.push(query.workspace);
    }
    sql += ' ORDER BY updated_at DESC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const candidates = rows.map((r) => this.rowToCard(r));

    const queryVec = await this.embedder.embed(text);
    const terms = text.toLowerCase().split(/\s+|[,，。.!！？；;]+/).filter(Boolean);
    const scored = candidates.map((memory) => {
      const haystack = `${memory.title} ${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
      const keyword = terms.length ? terms.filter((term) => haystack.includes(term)).length / terms.length : 0;
      const vector = memory.embedding && memory.embeddingVersion === EMBEDDING_VERSION ? Math.max(0, cosineSimilarity(queryVec, memory.embedding)) : 0;
      const freshness = memory.lastAccessedAt ? Math.max(0, 1 - (now - memory.lastAccessedAt) / (1000 * 60 * 60 * 24 * 30)) : 0;
      return { memory, score: vector * 0.65 + keyword * 0.25 + memory.importance * 0.06 + memory.confidence * 0.03 + freshness * 0.01 };
    }).filter((result) => result.score >= (query.threshold ?? 0.15)).sort((a, b) => b.score - a.score);

    const results = scored.slice(0, Math.max(0, query.limit ?? 5));
    if (results.length) {
      const update = this.db.prepare('UPDATE memories SET access_count=access_count+1,last_accessed_at=? WHERE id=?');
      const tx = this.db.transaction(() => results.forEach((result) => update.run(now, result.memory.id)));
      tx();
      results.forEach((result) => { result.memory.accessCount += 1; result.memory.lastAccessedAt = now; });
    }

    if (this.queryCache.size > 200) this.queryCache.clear();
    this.queryCache.set(cacheKey, { time: now, results });
    return results;
  }

  cleanCorruptedMemories(): number {
    const cards = this.listMemories();
    let purged = 0;
    const deleteStmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const card of cards) {
        if (isCorruptedMemory(card.content) || isCorruptedMemory(card.title)) {
          deleteStmt.run(card.id);
          purged++;
        }
      }
    });
    tx();
    if (purged > 0) this.queryCache.clear();
    return purged;
  }

  async extractTaskMemory(input: TaskMemoryInput): Promise<MemoryCard[]> {
    const cleanUser = extractCleanUserInput(input.userInput);
    const candidateTexts: Array<{ text: string; source: 'user' | 'assistant' }> = [];

    if (cleanUser) {
      const userSentences = cleanUser
        .split(/[\n。！？!?]+/)
        .map((line) => line.replace(/^[-*•\d\.]+\s*/, '').trim())
        .filter((line) => line.length >= 6 && /(必须|建议|统一|规范|约定|偏好|习惯|以后|优先|禁止|切记|不要使用|记得|遵守|always|must|prefer)/i.test(line));
      for (const s of userSentences) {
        if (isCleanMemoryCandidate(s)) {
          candidateTexts.push({ text: s, source: 'user' });
          if (candidateTexts.length >= 3) break;
        }
      }
    }

    if (input.assistantOutput && candidateTexts.length < 3) {
      const assistantSentences = input.assistantOutput
        .split(/[\n。！？!?]+/)
        .map((line) => line.replace(/^[-*•\d\.]+\s*/, '').trim())
        .filter((line) => line.length >= 8 && /(已修复|根因是|决定采用|重构为|架构设计为|规范约定为|必须统一|统一使用|规范要求|约定使用)/.test(line));
      for (const s of assistantSentences) {
        if (isCleanMemoryCandidate(s)) {
          candidateTexts.push({ text: s, source: 'assistant' });
          if (candidateTexts.length >= 3) break;
        }
      }
    }

    const cards: MemoryCard[] = [];
    for (const { text, source } of candidateTexts) {
      const category: MemoryCategory = /(已修复|根因|案例)/.test(text)
        ? 'case'
        : /(架构|接口|数据库|目录|路径|模块|服务)/.test(text)
        ? 'architecture'
        : /(规范|约定|风格|格式|命名)/.test(text)
        ? 'convention'
        : 'preference';

      const title = text.length > 30 ? `${text.slice(0, 30)}…` : text;
      cards.push(
        await this.addMemory({
          title,
          content: text,
          category,
          layer: category === 'case' ? 'episodic' : 'semantic',
          agentId: input.agentId,
          workspace: input.workspace,
          sourceTaskId: input.taskId,
          importance: source === 'user' ? 0.8 : 0.6,
          confidence: source === 'user' ? 0.9 : 0.7,
          dedupeKey: `${input.agentId}:${input.workspace || ''}:${text.toLowerCase()}`,
        }),
      );
    }
    return cards;
  }
}
