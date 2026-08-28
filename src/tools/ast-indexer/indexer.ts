import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { CodeSymbol, SymbolReference, SymbolKind } from './types.js';

const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.hpp'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target', 'vendor', '__pycache__'
]);

export class AstSymbolIndexer {
  private static instance: AstSymbolIndexer;
  private readonly fileSymbolCache = new Map<string, { mtime: number; symbols: CodeSymbol[] }>();

  static getInstance(): AstSymbolIndexer {
    if (!AstSymbolIndexer.instance) {
      AstSymbolIndexer.instance = new AstSymbolIndexer();
    }
    return AstSymbolIndexer.instance;
  }

  /**
   * 解析单个源码文件中的符号。
   */
  parseFileSymbols(filePath: string): CodeSymbol[] {
    if (!existsSync(filePath)) return [];

    const stats = statSync(filePath);
    const cached = this.fileSymbolCache.get(filePath);
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.symbols;
    }

    const content = readFileSync(filePath, 'utf8');
    const symbols = this.extractSymbols(filePath, content);
    this.fileSymbolCache.set(filePath, { mtime: stats.mtimeMs, symbols });
    return symbols;
  }

  /**
   * 提取代码文本中的所有定义符号。
   */
  extractSymbols(filePath: string, content: string): CodeSymbol[] {
    const ext = extname(filePath).toLowerCase();
    const lines = content.split(/\r?\n/);
    const symbols: CodeSymbol[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lineNum = i + 1;
      const trimmed = line.trim();

      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        this.extractJsTsLine(filePath, lineNum, line, trimmed, symbols);
      } else if (ext === '.py') {
        this.extractPythonLine(filePath, lineNum, line, trimmed, symbols);
      } else if (ext === '.go') {
        this.extractGoLine(filePath, lineNum, line, trimmed, symbols);
      } else if (ext === '.rs') {
        this.extractRustLine(filePath, lineNum, line, trimmed, symbols);
      }
    }

    return symbols;
  }

  private extractJsTsLine(filePath: string, lineNum: number, line: string, trimmed: string, symbols: CodeSymbol[]): void {
    const isExported = trimmed.startsWith('export ');

    // 1. 函数声明: function foo(...) / export async function foo(...)
    const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/);
    if (fnMatch && fnMatch[1]) {
      symbols.push({
        name: fnMatch[1],
        kind: 'function',
        filePath,
        line: lineNum,
        signature: `function ${fnMatch[1]}(${fnMatch[2] || ''})`,
        exported: isExported,
      });
      return;
    }

    // 2. 类声明: class Foo / export class Foo
    const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/);
    if (classMatch && classMatch[1]) {
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        filePath,
        line: lineNum,
        signature: `class ${classMatch[1]}`,
        exported: isExported,
      });
      return;
    }

    // 3. 接口声明: interface Foo / export interface Foo
    const ifaceMatch = line.match(/(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/);
    if (ifaceMatch && ifaceMatch[1]) {
      symbols.push({
        name: ifaceMatch[1],
        kind: 'interface',
        filePath,
        line: lineNum,
        signature: `interface ${ifaceMatch[1]}`,
        exported: isExported,
      });
      return;
    }

    // 4. 类型别名: type Foo = / export type Foo =
    const typeMatch = line.match(/(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/);
    if (typeMatch && typeMatch[1]) {
      symbols.push({
        name: typeMatch[1],
        kind: 'type',
        filePath,
        line: lineNum,
        signature: `type ${typeMatch[1]}`,
        exported: isExported,
      });
      return;
    }

    // 5. 变量/箭头函数: const foo = (...) => ...
    const arrowFnMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
    if (arrowFnMatch && arrowFnMatch[1]) {
      symbols.push({
        name: arrowFnMatch[1],
        kind: 'function',
        filePath,
        line: lineNum,
        signature: `const ${arrowFnMatch[1]} = (...) =>`,
        exported: isExported,
      });
      return;
    }

    // 6. Enum 声明: enum Foo / export enum Foo
    const enumMatch = line.match(/(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)/);
    if (enumMatch && enumMatch[1]) {
      symbols.push({
        name: enumMatch[1],
        kind: 'enum',
        filePath,
        line: lineNum,
        signature: `enum ${enumMatch[1]}`,
        exported: isExported,
      });
    }
  }

  private extractPythonLine(filePath: string, lineNum: number, line: string, trimmed: string, symbols: CodeSymbol[]): void {
    const fnMatch = line.match(/^def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\):/);
    if (fnMatch && fnMatch[1]) {
      symbols.push({
        name: fnMatch[1],
        kind: 'function',
        filePath,
        line: lineNum,
        signature: `def ${fnMatch[1]}(${fnMatch[2] || ''})`,
      });
      return;
    }

    const classMatch = line.match(/^class\s+([a-zA-Z0-9_]+)/);
    if (classMatch && classMatch[1]) {
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        filePath,
        line: lineNum,
        signature: `class ${classMatch[1]}`,
      });
    }
  }

  private extractGoLine(filePath: string, lineNum: number, line: string, trimmed: string, symbols: CodeSymbol[]): void {
    const fnMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (fnMatch && fnMatch[1]) {
      symbols.push({
        name: fnMatch[1],
        kind: 'function',
        filePath,
        line: lineNum,
        signature: `func ${fnMatch[1]}`,
      });
      return;
    }

    const typeMatch = line.match(/^type\s+([a-zA-Z0-9_]+)\s+(?:struct|interface)/);
    if (typeMatch && typeMatch[1]) {
      symbols.push({
        name: typeMatch[1],
        kind: 'interface',
        filePath,
        line: lineNum,
        signature: `type ${typeMatch[1]}`,
      });
    }
  }

  private extractRustLine(filePath: string, lineNum: number, line: string, trimmed: string, symbols: CodeSymbol[]): void {
    const fnMatch = line.match(/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/);
    if (fnMatch && fnMatch[1]) {
      symbols.push({
        name: fnMatch[1],
        kind: 'function',
        filePath,
        line: lineNum,
        signature: `fn ${fnMatch[1]}`,
      });
      return;
    }

    const structMatch = line.match(/(?:pub\s+)?(?:struct|enum|trait)\s+([a-zA-Z0-9_]+)/);
    if (structMatch && structMatch[1]) {
      symbols.push({
        name: structMatch[1],
        kind: 'class',
        filePath,
        line: lineNum,
        signature: `${structMatch[1]}`,
      });
    }
  }

  /**
   * 递归扫描工作区内的所有源码文件。
   */
  scanWorkspaceFiles(dirPath: string): string[] {
    const results: string[] = [];
    if (!existsSync(dirPath)) return results;

    const walk = (dir: string) => {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (IGNORED_DIRS.has(file)) continue;
          const full = join(dir, file);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else if (stat.isFile() && SUPPORTED_EXTS.has(extname(file).toLowerCase())) {
            results.push(full);
          }
        }
      } catch {}
    };

    walk(dirPath);
    return results;
  }

  /**
   * 跨工程毫秒级精确查找符号定义。
   */
  findDefinition(symbolName: string, workspacePath: string): CodeSymbol[] {
    const files = this.scanWorkspaceFiles(workspacePath);
    const matches: CodeSymbol[] = [];

    for (const f of files) {
      const symbols = this.parseFileSymbols(f);
      for (const s of symbols) {
        if (s.name === symbolName) {
          matches.push(s);
        }
      }
    }

    return matches;
  }

  /**
   * 跨工程查找所有引用了该符号的文件与行号。
   */
  findReferences(symbolName: string, workspacePath: string): SymbolReference[] {
    const files = this.scanWorkspaceFiles(workspacePath);
    const regex = new RegExp(`\\b${symbolName}\\b`);
    const refs: SymbolReference[] = [];

    for (const f of files) {
      try {
        const content = readFileSync(f, 'utf8');
        if (!regex.test(content)) continue;

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (l && regex.test(l)) {
            refs.push({
              symbol: symbolName,
              filePath: f,
              line: i + 1,
              lineContent: l.trim(),
            });
          }
        }
      } catch {}
    }

    return refs;
  }
}
