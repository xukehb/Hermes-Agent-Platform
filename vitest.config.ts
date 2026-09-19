import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Clean stray build/Release/better_sqlite3.node so bindings falls back to lib/binding/
const releaseNode = join(process.cwd(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (existsSync(releaseNode)) {
  try {
    unlinkSync(releaseNode);
  } catch {}
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    fileParallelism: false,
    testTimeout: 20000,
  },
});

