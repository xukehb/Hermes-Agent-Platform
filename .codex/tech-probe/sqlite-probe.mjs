// SQLite 方案实测（执行者：Codex，日期：2026-08-24）
// 目的：确认 better-sqlite3 在 Windows + Node 22 上开箱可用（预编译二进制，无需 node-gyp）
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, agent TEXT, role TEXT, content TEXT)');
const insert = db.prepare('INSERT INTO messages(agent, role, content) VALUES (?, ?, ?)');
const tx = db.transaction((rows) => { for (const r of rows) insert.run(r.agent, r.role, r.content); });
tx([
  { agent: 'r1', role: 'user', content: '统计仓库文件数' },
  { agent: 'r1', role: 'assistant', content: '<tool_call>...</tool_call>' },
  { agent: 'r2', role: 'user', content: '写单元测试' },
]);

console.log('BS3_VERSION=' + db.prepare('SELECT sqlite_version() AS v').get().v);
console.log('BS3_ROWS=' + db.prepare('SELECT COUNT(*) AS c FROM messages WHERE agent = ?').get('r1').c);
console.log('BS3_WAL=' + JSON.stringify(db.pragma('journal_mode = WAL')));
db.close();
