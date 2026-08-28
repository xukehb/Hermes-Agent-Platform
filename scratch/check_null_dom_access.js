import fs from 'node:fs';

const js = fs.readFileSync('src/gui/renderer/app.js', 'utf8');
const html = fs.readFileSync('src/gui/renderer/index.html', 'utf8');

const idMatches = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m => m[1]);
const staticIds = new Set(idMatches);

const lines = js.split('\n');
const dangerousLines = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  // 匹配 $('xyz').property 且没有加 ?.
  const matches = line.matchAll(/\$\(['"]([^'"]+)['"]\)\.([a-zA-Z0-9_$]+)/g);
  for (const m of matches) {
    const id = m[1];
    const prop = m[2];
    
    // 如果这个 ID 在 HTML 中不存在，而且前面没有 if ($('id')) 保护
    if (!staticIds.has(id)) {
      // 检查当前行或上一行是否有 if ($('...'))
      const prevLine = i > 0 ? lines[i - 1] : '';
      if (!line.includes(`if ($('${id}'))`) && !line.includes(`if ($("${id}"))`) &&
          !prevLine.includes(`if ($('${id}'))`) && !prevLine.includes(`if ($("${id}"))`)) {
        dangerousLines.push({ lineNum: i + 1, id, prop, text: line.trim() });
      }
    }
  }
}

console.log('=== 危险 DOM 访问检测 (Unsafe $().prop on non-existent static IDs) ===');
console.log('发现危险访问数:', dangerousLines.length);
dangerousLines.forEach(d => {
  console.log(`Line ${d.lineNum}: $('${d.id}').${d.prop} -> ${d.text}`);
});
