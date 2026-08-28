import fs from 'node:fs';
import path from 'node:path';

const rootDir = 'c:\\Users\\xk\\Documents\\ChatGPT\\CodexConnect';
const htmlPath = path.join(rootDir, 'src/gui/renderer/index.html');
const jsPath = path.join(rootDir, 'src/gui/renderer/app.js');
const preloadPath = path.join(rootDir, 'src/gui/renderer/preload.cjs');
const mainPath = path.join(rootDir, 'src/gui/main.ts');
const servicePath = path.join(rootDir, 'src/gui/service.ts');

const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const main = fs.readFileSync(mainPath, 'utf8');
const service = fs.readFileSync(servicePath, 'utf8');

const report = {
  duplicateIds: [],
  missingInlineFunctions: [],
  missingIpcHandlers: [],
  missingIpcMethodsInPreload: [],
  unprotectedDomQueries: [],
  potentialSyntaxIssues: []
};

// 1. 检查 index.html 中的重复 ID
const idMatches = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m => m[1]);
const idCount = {};
idMatches.forEach(id => {
  idCount[id] = (idCount[id] || 0) + 1;
});
Object.entries(idCount).forEach(([id, count]) => {
  if (count > 1) {
    report.duplicateIds.push({ id, count });
  }
});

// 2. 检查 index.html 中的内联 onclick/onchange/onsubmit 调用
const inlineEventRegex = /\s(on[a-z]+)=["']([^"']+)["']/gi;
const inlineCalls = [];
let match;
while ((match = inlineEventRegex.exec(html)) !== null) {
  const code = match[2];
  // 提取函数名，例如 window.foo(...) 或 foo(...)
  const fnMatches = code.matchAll(/(?:window\.)?([a-zA-Z0-9_$]+)\s*\(/g);
  for (const fn of fnMatches) {
    const fnName = fn[1];
    // 忽略原生或常规关键字
    if (!['alert', 'confirm', 'prompt', 'event', 'stopPropagation', 'preventDefault', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent'].includes(fnName)) {
      inlineCalls.push(fnName);
    }
  }
}

const uniqueInlineCalls = [...new Set(inlineCalls)];
uniqueInlineCalls.forEach(fn => {
  // 检查在 js 中是否定义为 function fnName 或 window.fnName = 或 const fnName =
  const hasDef = 
    js.includes(`function ${fn}`) ||
    js.includes(`window.${fn}`) ||
    js.includes(`${fn} =`) ||
    js.includes(`const ${fn}`) ||
    js.includes(`let ${fn}`);
  if (!hasDef) {
    report.missingInlineFunctions.push(fn);
  }
});

// 3. 检查 preload.cjs 与 main.ts 的 IPC 通道对齐
const preloadIpcChannels = [...preload.matchAll(/call\(['"](gui:[^'"]+)['"]/g)].map(m => m[1]);
const mainIpcChannels = [...main.matchAll(/ipcMain\.handle\(['"](gui:[^'"]+)['"]/g)].map(m => m[1]);

preloadIpcChannels.forEach(chan => {
  if (!mainIpcChannels.includes(chan)) {
    report.missingIpcHandlers.push(chan);
  }
});

mainIpcChannels.forEach(chan => {
  if (!preloadIpcChannels.includes(chan)) {
    report.missingIpcMethodsInPreload.push(chan);
  }
});

// 4. 检查 app.js 中的 $('...') 引用
const domQueries = [...js.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
const uniqueQueries = [...new Set(domQueries)];
const missingDomIds = [];
uniqueQueries.forEach(id => {
  if (!idCount[id]) {
    missingDomIds.push(id);
  }
});

console.log('=== 全局静态分析诊断报告 ===');
console.log('1. 重复 DOM ID (count > 1):', JSON.stringify(report.duplicateIds, null, 2));
console.log('2. HTML 中调用但 app.js 未定义的内联函数:', JSON.stringify(report.missingInlineFunctions, null, 2));
console.log('3. preload.cjs 中声明但 main.ts 缺失处理器的 IPC 通道:', JSON.stringify(report.missingIpcHandlers, null, 2));
console.log('4. main.ts 中存在但 preload.cjs 未暴露的 IPC 通道:', JSON.stringify(report.missingIpcMethodsInPreload, null, 2));
console.log('5. app.js 中引用但 HTML 中未发现静态 ID 的选择器数量:', missingDomIds.length);
console.log('部分动态/未声明 DOM ID 清单:', missingDomIds);
