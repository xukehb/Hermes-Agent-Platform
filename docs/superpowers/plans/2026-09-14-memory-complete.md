# Memory Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将本地记忆雏形升级为事务化 SQLite、自动提炼、混合召回并贯通三端的完整离线记忆功能。

**Architecture:** 以 `MemoryStore` 作为 SQLite 持久化边界，增加提炼模块并让编排器在任务前后调用；CLI/Web/GUI 共享 `MemoryCard` 契约。向量仍使用本地确定性 embedder，搜索加入关键词和元数据评分。

**Tech Stack:** TypeScript、better-sqlite3、Vitest、Electron IPC、Hono。

---

### Task 1: 扩展类型和 schema 契约

**Files:**
- Modify: `src/memory/types.ts`
- Test: `tests/memory.test.ts`

- [ ] 添加 layer、agentId、importance、confidence、expiresAt、embeddingVersion 字段及输入类型。
- [ ] 添加校验/默认值测试，确保旧卡片字段可读取。
- [ ] 运行 `npx vitest run tests/memory.test.ts`，确认新增测试先失败。

### Task 2: SQLite 存储与 JSON 迁移

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/memory.test.ts`

- [ ] 使用 `better-sqlite3` 创建 schema、索引和事务 CRUD。
- [ ] 迁移旧 JSON，成功后保留 `.migrated` 备份；损坏数据抛出错误。
- [ ] 以串行写入队列包住异步 embedding 后的提交。
- [ ] 补并发新增、迁移、损坏文件和访问统计测试。

### Task 3: 混合召回、更新、重建与自动提炼

**Files:**
- Modify: `src/memory/store.ts`
- Create: `src/memory/extractor.ts`
- Modify: `src/memory/recall.ts`
- Test: `tests/memory.test.ts`

- [ ] 实现关键词 + 向量混合评分、过期过滤、agent/workspace 过滤。
- [ ] 实现 updateMemory、rebuildEmbeddings、extractTaskMemory 及相似去重合并。
- [ ] 限制 prompt 注入长度，补充边界测试。

### Task 4: 编排器自动记忆闭环

**Files:**
- Modify: `src/agent/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

- [ ] 传递 agentId/workspace 召回上下文。
- [ ] 任务成功后异步提炼，失败只记录日志。
- [ ] 补充成功、失败和关闭流程测试。

### Task 5: CLI、Web、GUI 契约

**Files:**
- Modify: `src/cli/memory-commands.ts`
- Modify: `src/web/server.ts`
- Modify: `src/gui/service.ts`
- Modify: `src/gui/main.ts`
- Modify: `src/gui/renderer/app.js`
- Modify: `src/gui/renderer/index.html`
- Test: `tests/web-server.test.ts`, `tests/gui-missing-features.test.ts`

- [ ] 增加 update/rebuild/extract 和删除接口。
- [ ] 统一 agentId、title、tags、workspace 等字段并做运行时校验。
- [ ] GUI 支持编辑、元数据和重建索引。

### Task 6: 全量验证与文档记录

**Files:**
- Modify: `.codex/testing.md`
- Modify: `verification.md`
- Create: `.codex/review-report.md`

- [ ] 运行 `npm run typecheck`、`npm test`、`npm run lint`、CLI 冒烟。
- [ ] 记录输出、失败原因和残余风险。
