import fs from 'node:fs';

const file = 'src/gui/renderer/app.js';
let js = fs.readFileSync(file, 'utf8');

const targetFunctionHeader = `// 重构 refreshHostView 支持监控任意节点
window.refreshHostView = async () => {`;

const newFunctionHeader = `let isRefreshingHost = false;

// 重构 refreshHostView 支持监控任意节点 (带并发防抖锁)
window.refreshHostView = async () => {
  if (isRefreshingHost) return;
  isRefreshingHost = true;`;

js = js.replace(targetFunctionHeader, newFunctionHeader);

const targetFunctionEnd = `      if ($('hostCwd')) $('hostCwd').textContent = \`/root/.hap/\`;
    }
  } catch (error) {
    // ignore
  }
};`;

const newFunctionEnd = `      if ($('hostCwd')) $('hostCwd').textContent = \`/root/.hap/\`;
    }
  } catch (error) {
    // ignore
  } finally {
    isRefreshingHost = false;
  }
};`;

js = js.replace(targetFunctionEnd, newFunctionEnd);

fs.writeFileSync(file, js, 'utf8');
console.log('Successfully added concurrency lock to refreshHostView in app.js');
