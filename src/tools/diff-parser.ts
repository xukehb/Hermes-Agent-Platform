/**
 * Git Unified Diff 结构化解析器。
 * 将 git diff 输出文本解析为结构化的文件列表、差异块 (Hunks) 及行级变更。
 */

export interface DiffLine {
  type: 'add' | 'delete' | 'context';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiffItem {
  oldPath: string;
  newPath: string;
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary?: boolean;
}

export function parseUnifiedDiff(diffText: string): FileDiffItem[] {
  if (!diffText || !diffText.trim()) {
    return [];
  }

  const files: FileDiffItem[] = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile: FileDiffItem | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // 检测文件头部 diff --git a/file b/file
    if (line.startsWith('diff --git ')) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        files.push(currentFile);
      }

      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      const oldPath = match ? match[1] ?? '' : '';
      const newPath = match ? match[2] ?? '' : '';

      currentFile = {
        oldPath: oldPath || 'unknown',
        newPath: newPath || oldPath || 'unknown',
        path: newPath || oldPath || 'unknown',
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted';
      continue;
    }
    if (line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) {
      currentFile.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') && line.includes('differ')) {
      currentFile.isBinary = true;
      continue;
    }

    // 检测块头部 @@ -1,5 +1,6 @@
    if (line.startsWith('@@ ')) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (hunkMatch) {
        const oldStart = parseInt(hunkMatch[1] ?? '1', 10);
        const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3] ?? '1', 10);
        const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
        const header = hunkMatch[5]?.trim() ?? '';

        oldLine = oldStart;
        newLine = newStart;

        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          header,
          lines: [],
        };
      }
      continue;
    }

    if (!currentHunk) continue;

    // 解析行内容
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentFile.additions++;
      currentHunk.lines.push({
        type: 'add',
        newLineNumber: newLine++,
        content: line.slice(1),
      });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentFile.deletions++;
      currentHunk.lines.push({
        type: 'delete',
        oldLineNumber: oldLine++,
        content: line.slice(1),
      });
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({
        type: 'context',
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
        content: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  }

  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * 将单个 DiffHunk 构造成标准 git apply unified diff 补丁文本。
 */
export function buildHunkPatch(filePath: string, hunk: DiffHunk): string {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const lines: string[] = [
    `diff --git a/${normPath} b/${normPath}`,
    `--- a/${normPath}`,
    `+++ b/${normPath}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ' ' + hunk.header : ''}`,
  ];

  for (const line of hunk.lines) {
    const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
    lines.push(prefix + line.content);
  }

  return lines.join('\n') + '\n';
}
