import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const root = process.argv[2];
if (!root || !existsSync(root)) throw new Error('需要提供已下载构建产物目录');

function findMetadata(directory) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...findMetadata(path));
    else if (/^latest-mac-(?:macos-arm64|macos-x64)\.yml$/.test(entry.name)) matches.push(path);
  }
  return matches;
}

const metadataPaths = findMetadata(root).sort();
if (metadataPaths.length !== 2) {
  throw new Error(`预期找到 2 个 macOS 更新清单，实际找到 ${metadataPaths.length} 个`);
}

const [first, second] = metadataPaths.map((path) => yaml.load(readFileSync(path, 'utf8')));
if (!first || !second || first.version !== second.version) throw new Error('macOS 更新清单版本不一致');

const files = [...(first.files ?? []), ...(second.files ?? [])];
const urls = new Set(files.map((file) => file.url));
if (files.length !== 2 || urls.size !== 2 || !files.every((file) => file.url?.endsWith('.zip'))) {
  throw new Error('macOS 更新清单必须包含 arm64 和 x64 两个 ZIP');
}

writeFileSync(join(root, 'latest-mac.yml'), yaml.dump({
  version: first.version,
  files,
  path: first.path,
  sha512: first.sha512,
  releaseDate: first.releaseDate ?? second.releaseDate,
}, { lineWidth: -1 }), 'utf8');
for (const path of metadataPaths) rmSync(path);
