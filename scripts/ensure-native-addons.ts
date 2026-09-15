import { existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();
const moduleRoot = join(projectRoot, 'node_modules', 'better-sqlite3');
const releaseNode = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
const bindingDir = join(moduleRoot, 'lib', 'binding');

const electronAbiDir = join(bindingDir, 'node-v136-linux-x64');
const electronTarget = join(electronAbiDir, 'better_sqlite3.node');

const nodeAbiDir = join(bindingDir, 'node-v137-linux-x64');
const nodeTarget = join(nodeAbiDir, 'better_sqlite3.node');

mkdirSync(electronAbiDir, { recursive: true });
mkdirSync(nodeAbiDir, { recursive: true });

if (existsSync(releaseNode)) {
  const isElectron = process.argv.includes('--electron') || Boolean(process.versions.electron);
  const isNode = process.argv.includes('--node');
  if (isElectron && !isNode) {
    copyFileSync(releaseNode, electronTarget);
    console.log('[Native Addon] Saved Electron ABI 136 better_sqlite3.node');
  } else {
    copyFileSync(releaseNode, nodeTarget);
    console.log('[Native Addon] Saved Node ABI 137 better_sqlite3.node');
  }
  try {
    unlinkSync(releaseNode);
  } catch {}
}

if (existsSync(electronTarget) && existsSync(nodeTarget)) {
  console.log('[Native Addon] Dual ABI bindings verified for both Electron (136) and Node (137).');
} else {
  console.log('[Native Addon] Status:', {
    electronBinding: existsSync(electronTarget),
    nodeBinding: existsSync(nodeTarget),
  });
}
