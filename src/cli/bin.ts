#!/usr/bin/env node
/**
 * hap 可执行入口。
 *
 * 与 index.ts 分离的原因：index.ts 需要被测试直接 import 来跑 parseAsync，
 * 若在模块顶层自动执行 main()，任何 import 都会连带解析 process.argv。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { main } from './index.js';

await main();
