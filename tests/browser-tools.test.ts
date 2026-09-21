import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_NAMES, TOOL_PROFILES, AGENT_TEMPLATES } from '../src/config/defaults.js';
import { builtinTools } from '../src/tools/builtin/index.js';
import {
  browserOpenTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserGetContentTool,
  browserEvaluateTool,
  browserScrollTool,
  browserCloseTool,
} from '../src/tools/builtin/browser-tools.js';
import { BrowserController } from '../src/tools/browser/browser-controller.js';

describe('浏览器操控工具集 (Browser Control Tools)', () => {
  const browserToolNames = [
    'browser_open',
    'browser_navigate',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_get_content',
    'browser_evaluate',
    'browser_scroll',
    'browser_close',
  ];

  it('9 个浏览器工具全部注册在 BUILTIN_TOOL_NAMES 与 builtinTools() 中', () => {
    const builtins = builtinTools();
    for (const name of browserToolNames) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
      expect(builtins.some((t) => t.definition.name === name)).toBe(true);
    }
  });

  it('已纳入 full 档位以及 automator 智能体模板', () => {
    for (const name of browserToolNames) {
      expect(TOOL_PROFILES.full).toContain(name);
    }
    expect(AGENT_TEMPLATES['automator']?.tools?.profile).toBe('full');
  });

  it('各工具具备完备的 schema 校验与参数定义', () => {
    // browser_open
    expect(browserOpenTool.definition.name).toBe('browser_open');
    expect(browserOpenTool.validate?.({ url: 'https://github.com' }).ok).toBe(true);
    expect(browserOpenTool.validate?.({ url: '' }).ok).toBe(false);

    // browser_navigate
    expect(browserNavigateTool.definition.name).toBe('browser_navigate');
    expect(browserNavigateTool.validate?.({ url: 'https://bing.com' }).ok).toBe(true);
    expect(browserNavigateTool.validate?.({ url: '' }).ok).toBe(false);

    // browser_click
    expect(browserClickTool.definition.name).toBe('browser_click');
    expect(browserClickTool.validate?.({ selector: '#submit-btn' }).ok).toBe(true);
    expect(browserClickTool.validate?.({ x: 100, y: 200 }).ok).toBe(true);

    // browser_type
    expect(browserTypeTool.definition.name).toBe('browser_type');
    expect(browserTypeTool.validate?.({ selector: 'input[name="q"]', text: 'Hermes Agent' }).ok).toBe(true);

    // browser_scroll
    expect(browserScrollTool.definition.name).toBe('browser_scroll');
    expect(browserScrollTool.validate?.({ direction: 'down', amount: 500 }).ok).toBe(true);
    expect(browserScrollTool.validate?.({ direction: 'invalid_dir' as any }).ok).toBe(false);

    // browser_evaluate
    expect(browserEvaluateTool.definition.name).toBe('browser_evaluate');
    expect(browserEvaluateTool.validate?.({ script: 'document.title' }).ok).toBe(true);
    expect(browserEvaluateTool.validate?.({ script: '' }).ok).toBe(false);

    // browser_screenshot
    expect(browserScreenshotTool.definition.name).toBe('browser_screenshot');
    expect(browserScreenshotTool.validate?.({ fullPage: true }).ok).toBe(true);

    // browser_get_content
    expect(browserGetContentTool.definition.name).toBe('browser_get_content');

    // browser_close
    expect(browserCloseTool.definition.name).toBe('browser_close');
  });

  it('BrowserController 单例与浏览器探测能力正常', () => {
    const controller = BrowserController.getInstance();
    expect(controller).toBeDefined();
    expect(BrowserController.getInstance()).toBe(controller);

    // 检测能否成功在当前环境探测到浏览器或返回安全兜底
    const execPath = controller.detectBrowserExecutable();
    expect(typeof execPath).toBe('string');
    expect(execPath.length).toBeGreaterThan(0);
  });

  it('入参缺失或操作异常时返回安全优雅的错误处理', async () => {
    const dummyCtx: any = {
      taskId: 'browser-test-task',
      agent: { id: 'automator' },
      stepIndex: 1,
      workingDirectory: process.cwd(),
      environment: {},
      abortSignal: new AbortController().signal,
    };

    // browser_click 既未传 selector 又未传坐标时，应返回友好错误
    const res = await browserClickTool.run({}, dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('click 操作必须提供');
  });
});
