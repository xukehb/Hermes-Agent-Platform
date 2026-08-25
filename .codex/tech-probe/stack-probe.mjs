// 依赖可用性实测（执行者：Codex，日期：2026-08-24）
// 目的：确认候选依赖在本机 Node 22 + Windows 下可正常导入并暴露预期入口
const targets = [
  ['grammy', 'Bot'],
  ['commander', 'Command'],
  ['hono', 'Hono'],
  ['execa', 'execa'],
  ['pino', 'default'],
  ['@clack/prompts', 'text'],
  ['smol-toml', 'parse'],
  ['zod', 'z'],
];

for (const [pkg, expectedExport] of targets) {
  try {
    const mod = await import(pkg);
    const version = await import(`${pkg}/package.json`, { with: { type: 'json' } })
      .then((m) => m.default.version)
      .catch(() => 'n/a');
    const ok = expectedExport in mod || expectedExport === 'default';
    console.log(`IMPORT ${pkg}@${version} export_${expectedExport}=${ok}`);
  } catch (error) {
    console.log(`IMPORT ${pkg} FAILED ${error.code ?? error.message}`);
  }
}
