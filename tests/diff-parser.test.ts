import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, buildHunkPatch } from '../src/tools/diff-parser.js';

describe('Unified Diff Parser', () => {
  it('parses empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n  ')).toEqual([]);
  });

  it('parses single modified file with additions and deletions', () => {
    const rawDiff = `
diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
    `.trim();

    const result = parseUnifiedDiff(rawDiff);
    expect(result).toHaveLength(1);
    const file = result[0]!;
    expect(file.path).toBe('src/index.ts');
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]).toEqual({ type: 'context', oldLineNumber: 1, newLineNumber: 1, content: 'const a = 1;' });
    expect(hunk.lines[1]).toEqual({ type: 'delete', oldLineNumber: 2, content: 'const b = 2;' });
    expect(hunk.lines[2]).toEqual({ type: 'add', newLineNumber: 2, content: 'const b = 3;' });
    expect(hunk.lines[3]).toEqual({ type: 'add', newLineNumber: 3, content: 'const c = 4;' });
  });

  it('parses new file and deleted file modes', () => {
    const rawDiff = `
diff --git a/src/new-feature.ts b/src/new-feature.ts
new file mode 100644
--- /dev/null
+++ b/src/new-feature.ts
@@ -0,0 +1,2 @@
+export const hello = 'world';
+export const version = 1;
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
--- a/src/legacy.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const deprecated = true;
-console.log('bye');
    `.trim();

    const result = parseUnifiedDiff(rawDiff);
    expect(result).toHaveLength(2);

    expect(result[0]!.path).toBe('src/new-feature.ts');
    expect(result[0]!.status).toBe('added');
    expect(result[0]!.additions).toBe(2);
    expect(result[0]!.deletions).toBe(0);

    expect(result[1]!.path).toBe('src/legacy.ts');
    expect(result[1]!.status).toBe('deleted');
    expect(result[1]!.additions).toBe(0);
    expect(result[1]!.deletions).toBe(2);
  });

  it('buildHunkPatch 生成标准且可用于 git apply 的补丁块', () => {
    const rawDiff = `
diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -10,3 +10,4 @@
 line 1
-line 2
+line 2 mod
+line 3 new
    `.trim();

    const [file] = parseUnifiedDiff(rawDiff);
    expect(file?.hunks).toHaveLength(1);
    const patch = buildHunkPatch('src/test.ts', file!.hunks[0]!);
    expect(patch).toContain('diff --git a/src/test.ts b/src/test.ts');
    expect(patch).toContain('@@ -10,3 +10,4 @@');
    expect(patch).toContain('+line 2 mod');
    expect(patch).toContain('-line 2');
  });
});
