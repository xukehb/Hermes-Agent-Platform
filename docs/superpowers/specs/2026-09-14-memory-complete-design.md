# 记忆功能完整实现设计

> 日期：2026-09-14  执行者：Codex

## 目标

将现有本地向量记忆雏形升级为可长期运行的离线记忆系统：使用 SQLite 事务持久化，支持 semantic/episodic 记忆、自动提炼、去重合并、工作区与智能体隔离、混合召回，并贯通 CLI、Web、GUI 与任务编排器。

## 架构

- `MemoryStore` 负责 SQLite schema、旧 JSON 迁移、事务和记忆 CRUD。
- `MemoryRetriever` 逻辑保留在 store/search 路径中，组合向量相似度和关键词评分。
- `MemoryExtractor` 从已完成任务的结构化上下文中提炼稳定候选，执行校验和相似合并。
- `recallRelevantMemories` 只负责把召回结果格式化为受长度限制的 system prompt 片段。
- `AgentOrchestrator` 在任务开始前召回，在任务成功后异步提炼；记忆错误不阻断任务。

## 数据契约

`MemoryCard` 增加 `layer`、`agentId`、`importance`、`confidence`、`expiresAt`、`embeddingVersion`；类别保留 `preference/fact/case/architecture`。SQLite 使用 JSON 文本保存 tags 与 embedding，避免额外原生扩展依赖。

## 行为

1. 首次打开数据库时创建 schema；同目录存在旧 `memories.json` 时在事务中迁移，成功后改名为 `.migrated`。
2. 损坏 JSON、损坏 SQLite 或迁移失败抛出明确错误，不返回空状态。
3. 写入和访问统计都使用事务；同一进程的异步 embedding 通过串行队列提交。
4. 搜索先按过滤条件筛选，再计算向量与关键词混合分数，剔除过期记录，按分数、重要性、置信度和访问新鲜度排序。
5. 自动提炼只在成功任务后执行；空内容、一次性内容和低置信度内容丢弃；相同 `dedupeKey` 或高相似度内容更新原记忆。
6. 注入 prompt 时限制最多 3 条、最多 4000 字符。

## 测试

覆盖存储迁移、并发写入、失败事务、CRUD、过滤与混合排序、去重合并、自动提炼、编排器接入以及 CLI/Web/GUI 契约；运行 typecheck、lint、Vitest 和本地 CLI 冒烟。
