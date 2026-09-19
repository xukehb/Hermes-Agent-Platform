import { execFileSync, execSync } from 'node:child_process';
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
const isForce = process.argv.includes('--force');

function readElectronAbi(): string {
  const require = createRequire(import.meta.url);
  const electronBinary = require('electron') as string;
  return execFileSync(electronBinary, ['-p', 'process.versions.modules'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim();
}

function readElectronVersion(): string {
  const require = createRequire(import.meta.url);
  const electronBinary = require('electron') as string;
  return execFileSync(electronBinary, ['-p', 'process.versions.electron'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim();
}

const abi = isElectron && !isNode ? readElectronAbi() : process.versions.modules;
const targetDir = join(bindingDir, `node-v${abi}-${platform}-${arch}`);
const target = join(targetDir, 'better_sqlite3.node');
mkdirSync(targetDir, { recursive: true });

// If target does not exist or force rebuild requested, compile it
if (!existsSync(target) || isForce) {
  console.log(`[Native Addon] Binary not found for ABI ${abi} (${isElectron ? 'Electron' : 'Node'}), compiling...`);
  if (isElectron) {
    const electronVer = readElectronVersion();
    execSync(`npx electron-rebuild -v ${electronVer} -f -w better-sqlite3`, { stdio: 'inherit' });
  } else {
    execSync(`npm rebuild better-sqlite3 --build-from-source`, { stdio: 'inherit' });
  }
}

if (existsSync(releaseNode)) {
  copyFileSync(releaseNode, target);
  console.log(`[Native Addon] Saved ${isElectron && !isNode ? 'Electron' : 'Node'} ABI ${abi} better_sqlite3.node`);
  try {
    unlinkSync(releaseNode);
  } catch {}
}

// Always ensure build/Release/better_sqlite3.node is removed so bindings falls back to lib/binding/node-v*
if (existsSync(releaseNode)) {
  try {
    unlinkSync(releaseNode);
  } catch {}
}

if (!existsSync(target)) throw new Error(`未找到 ABI ${abi} 的 better_sqlite3.node`);
console.log(`[Native Addon] Verified ${target}`);

