import { z } from 'zod';
import { defineTool } from '../define.js';
import { resolveInWorkspace } from '../workspace.js';
import { AstSymbolIndexer } from '../ast-indexer/index.js';

export const findDefinitionTool = defineTool({
  name: 'find_definition',
  description: '在当前代码工程中精确查找指定符号（函数、类、接口、类型别名等）的定义位置与声明签名。',
  schema: z.object({
    symbol: z.string().min(1).describe('要查找定义的符号名称，如 AgentOrchestrator, parseUnifiedDiff, UserProfile'),
    workspace: z.string().optional().describe('可选的目标工程目录，默认为当前工作区'),
  }),
  run: async (args, ctx) => {
    const symbol = args.symbol.trim();
    const workspace = args.workspace ? resolveInWorkspace(ctx.agent.workspace, args.workspace) : ctx.agent.workspace;
    const indexer = AstSymbolIndexer.getInstance();
    const matches = indexer.findDefinition(symbol, workspace);

    if (matches.length === 0) {
      return {
        content: `在工程中未找到符号 [${symbol}] 的精确定义。`,
        isError: false,
      };
    }

    const formatted = matches.map((m) => {
      return `- **[${m.kind}]** \`${m.signature || m.name}\`\n  文件: \`${m.filePath}:${m.line}\``;
    }).join('\n');

    return {
      content: `找到 ${matches.length} 处符号 [${symbol}] 的定义：\n\n${formatted}`,
      isError: false,
    };
  },
});

export const findReferencesTool = defineTool({
  name: 'find_references',
  description: '在当前代码工程中精确检索所有引用或调用指定符号的文件与行号。',
  schema: z.object({
    symbol: z.string().min(1).describe('要检索引用的符号名称'),
    workspace: z.string().optional().describe('可选的目标工程目录'),
  }),
  run: async (args, ctx) => {
    const symbol = args.symbol.trim();
    const workspace = args.workspace ? resolveInWorkspace(ctx.agent.workspace, args.workspace) : ctx.agent.workspace;
    const indexer = AstSymbolIndexer.getInstance();
    const refs = indexer.findReferences(symbol, workspace);

    if (refs.length === 0) {
      return {
        content: `在工程中未检索到对符号 [${symbol}] 的外部调用或引用。`,
        isError: false,
      };
    }

    const formatted = refs.slice(0, 30).map((r) => {
      return `- \`${r.filePath}:${r.line}\`: ${r.lineContent}`;
    }).join('\n');

    return {
      content: `共找到 ${refs.length} 处对 [${symbol}] 的引用：\n\n${formatted}`,
      isError: false,
    };
  },
});

export const listSymbolsTool = defineTool({
  name: 'list_symbols',
  description: '快速提取指定源码文件中的全部导出符号与声明清单，无需读取全文。',
  schema: z.object({
    file: z.string().min(1).describe('源码文件路径（相对或绝对路径）'),
  }),
  run: async (args, ctx) => {
    const filePath = resolveInWorkspace(ctx.agent.workspace, args.file.trim());
    const indexer = AstSymbolIndexer.getInstance();
    const symbols = indexer.parseFileSymbols(filePath);

    if (symbols.length === 0) {
      return {
        content: `文件 [${args.file}] 中未提取到顶层符号定义。`,
        isError: false,
      };
    }

    const formatted = symbols.map((s) => {
      return `- [${s.kind}] ${s.signature || s.name} (line ${s.line})${s.exported ? ' [export]' : ''}`;
    }).join('\n');

    return {
      content: `文件 [${args.file}] 包含 ${symbols.length} 个符号定义：\n\n${formatted}`,
      isError: false,
    };
  },
});
