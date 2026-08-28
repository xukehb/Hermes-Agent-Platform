import { describe, it, expect } from 'vitest';
import { AstSymbolIndexer } from '../src/tools/ast-indexer/indexer.js';
import { findDefinitionTool, findReferencesTool, listSymbolsTool } from '../src/tools/builtin/symbol-tools.js';

describe('AST Symbol Indexer & Code Intelligence Tools', () => {
  const indexer = AstSymbolIndexer.getInstance();

  it('extracts TypeScript/JavaScript functions, classes, interfaces, and types', () => {
    const code = `
export interface UserProfile {
  id: string;
  name: string;
}

export type AuthToken = string;

export class AuthManager {
  login() {}
}

export async function authenticateUser(token: AuthToken): Promise<UserProfile> {
  return { id: '1', name: 'admin' };
}

const handleCallback = () => {};
    `.trim();

    const symbols = indexer.extractSymbols('src/auth.ts', code);
    expect(symbols.length).toBeGreaterThanOrEqual(4);

    const iface = symbols.find(s => s.name === 'UserProfile');
    expect(iface).toBeDefined();
    expect(iface?.kind).toBe('interface');
    expect(iface?.exported).toBe(true);

    const cls = symbols.find(s => s.name === 'AuthManager');
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe('class');

    const fn = symbols.find(s => s.name === 'authenticateUser');
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe('function');
  });

  it('extracts Python functions and classes', () => {
    const pyCode = `
class NeuralNetwork:
    def __init__(self):
        pass

def train_model(epochs=10):
    pass
    `.trim();

    const symbols = indexer.extractSymbols('model.py', pyCode);
    expect(symbols.length).toBe(2);
    expect(symbols[0]?.name).toBe('NeuralNetwork');
    expect(symbols[0]?.kind).toBe('class');
    expect(symbols[1]?.name).toBe('train_model');
    expect(symbols[1]?.kind).toBe('function');
  });

  it('find_definition tool searches and returns symbols in codebase', async () => {
    const res = await findDefinitionTool.handler({
      symbol: 'AstSymbolIndexer',
      workspace: process.cwd(),
    }, { agent: { workspace: process.cwd() } } as any);

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('AstSymbolIndexer');
  });
});
