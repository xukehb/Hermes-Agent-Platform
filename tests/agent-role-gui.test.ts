import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererDir = resolve(process.cwd(), 'src/gui/renderer');
const html = readFileSync(resolve(rendererDir, 'index.html'), 'utf8');
const app = readFileSync(resolve(rendererDir, 'app.js'), 'utf8');
const css = readFileSync(resolve(rendererDir, 'styles.css'), 'utf8');
const preload = readFileSync(resolve(rendererDir, 'preload.cjs'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'src/gui/main.ts'), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('agent role management GUI', () => {
  it('supports distinct create and edit modes for agent roles', () => {
    const view = section(html, '<section id="agents"', '<!-- 独立视图: 远程服务器');
    const dialog = section(html, '<dialog id="agentModal"', '<!-- 弹窗 3: 项目');
    const controller = section(app, '// 5.5 智能体角色管理', '// 6. 模型目录管理');

    expect(view).toContain('id="addAgentBtn"');
    expect(dialog).toContain('id="agentInputId"');
    expect(dialog).not.toContain('type="hidden" id="agentInputId"');
    expect(dialog).toContain('id="agentSubmitBtn"');
    expect(controller).toContain("let agentFormMode = 'edit'");
    expect(controller).toContain("$('addAgentBtn')?.addEventListener");
    expect(controller).toContain('agentIdInput.readOnly = false');
    expect(controller).toContain('agentIdInput.readOnly = true');
    expect(controller).toContain("create: agentFormMode === 'create'");
  });

  it('routes confirmed agent deletion through the service boundary', () => {
    const controller = section(app, '// 5.5 智能体角色管理', '// 6. 模型目录管理');

    expect(preload).toContain("removeAgent: (id) => call('gui:removeAgent', id)");
    expect(main).toContain("ipcMain.handle('gui:removeAgent'");
    expect(main).toContain('service.removeAgent(id)');
    expect(controller).toContain('window.deleteAgentRole = async');
    expect(controller).toContain('await showConfirm({');
    expect(controller).toContain('await window.hap.removeAgent(agentId)');
    expect(controller).toContain('配置与引用将被删除');
    expect(controller).toContain('工作目录、记忆和会话文件会保留');
  });

  it('keeps the create action readable in a constrained window', () => {
    const view = section(html, '<section id="agents"', '<!-- 独立视图: 远程服务器');

    expect(view).toContain('class="page-header-row agent-page-header"');
    expect(css).toMatch(/\.agent-page-header \.btn\s*{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.agent-page-header\s*{[^}]*flex-wrap:\s*wrap/);
  });
});
