/**
 * 代码库 AST 语法分析与符号引用图谱类型定义。
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'method'
  | 'enum';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  filePath: string;
  line: number;
  signature?: string | undefined;
  doc?: string | undefined;
  exported?: boolean | undefined;
}

export interface SymbolReference {
  symbol: string;
  filePath: string;
  line: number;
  lineContent: string;
}

export interface FileSymbolSummary {
  filePath: string;
  symbols: CodeSymbol[];
}
