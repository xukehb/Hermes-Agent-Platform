import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const projectRoot = process.cwd();
const moduleRoot = join(projectRoot, 'node_modules', 'better-sqlite3');
const releaseNode = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
const bindingDir = join(moduleRoot, 'lib', 'binding');

const platform = process.platform;
const arch = process.arch;
const isElectron = process.argv.includes('--electron');
const isNode = process.argv.includes('--node');

function readElectronAbi(): string {
  const require = createRequire(import.meta.url);
  const electronBinary = require('electron') as string;
  return execFileSync(electronBinary, ['-p', 'process.versions.modules'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim();
}

const abi = isElectron && !isNode ? readElectronAbi() : process.versions.modules;
const targetDir = join(bindingDir, `node-v${abi}-${platform}-${arch}`);
const target = join(targetDir, 'better_sqlite3.node');
mkdirSync(targetDir, { recursive: true });

if (existsSync(releaseNode)) {
  copyFileSync(releaseNode, target);
  console.log(`[Native Addon] Saved ${isElectron && !isNode ? 'Electron' : 'Node'} ABI ${abi} better_sqlite3.node`);
  try {
    unlinkSync(releaseNode);
  } catch {}
}

if (!existsSync(target)) throw new Error(`未找到 ABI ${abi} 的 better_sqlite3.node`);
console.log(`[Native Addon] Verified ${target}`);
