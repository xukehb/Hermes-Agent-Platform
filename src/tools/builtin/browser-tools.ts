/**
 * 浏览器操控工具集 (Browser Control Tools)
 *
 * 为智能体提供全套浏览器浏览、交互、表单提交与截图提取能力。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../define.js';
import { BrowserController } from '../browser/browser-controller.js';

export const browserOpenTool = defineTool({
  name: 'browser_open',
  description: '在本地真实的 Chrome/Edge 浏览器中打开指定网址（若未启动则自动启动，支持前台可视化浏览或后台无头模式）',
  schema: z.object({
    url: z.string().min(1).describe('要访问的网址 URL（如 https://github.com）'),
    headless: z.boolean().optional().default(false).describe('是否无头模式静默运行，缺省为 false（可视化窗口模式，可看到浏览器交互操作）'),
    width: z.number().optional().default(1280).describe('窗口宽度，默认 1280'),
    height: z.number().optional().default(800).describe('窗口高度，默认 800'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      const res = await browser.ensureBrowser({
        url: args.url,
        headless: args.headless,
        width: args.width,
        height: args.height,
      });
      return {
        content: `🌐 浏览器已就绪并导航完成！\n- 页面标题: "${res.title}"\n- 当前网址: ${res.url}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `打开浏览器失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserNavigateTool = defineTool({
  name: 'browser_navigate',
  description: '让当前已连接的浏览器跳转导航到新的网页 URL',
  schema: z.object({
    url: z.string().min(1).describe('新的网页 URL'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      const res = await browser.navigate(args.url);
      return {
        content: `🌐 页面已成功跳转！\n- 标题: "${res.title}"\n- 网址: ${res.url}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `页面跳转失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserScreenshotTool = defineTool({
  name: 'browser_screenshot',
  description: '截取当前浏览器的网页画面并保存为本地图片，自动返回 Markdown 格式图片供视觉模型审查或用户预览',
  schema: z.object({
    fullPage: z.boolean().optional().default(false).describe('是否截取整个长网页（滚动截取全屏），缺省为 false（截取当前视口）'),
    outputFileName: z.string().optional().describe('自定义输出文件名，默认按时间戳生成'),
  }),
  run: async (args, ctx) => {
    try {
      const browser = BrowserController.getInstance();
      const workspace = ctx.agent.workspace || process.cwd();
      const screenshotsDir = join(workspace, 'browser_screenshots');
      if (!existsSync(screenshotsDir)) {
        mkdirSync(screenshotsDir, { recursive: true });
      }

      const timestamp = Date.now();
      const filename = (args.outputFileName || `browser_${timestamp}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const targetPath = resolve(screenshotsDir, filename);

      const shot = await browser.screenshot({
        fullPage: args.fullPage,
        outputPath: targetPath,
      });

      const normPath = shot.path.replace(/\\/g, '/');
      return {
        content: `📸 网页截图已捕获！\n\n![网页截图](file:///${normPath})\n\n- 文件路径: \`${shot.path}\`\n- 分辨率: ${shot.width}x${shot.height}${args.fullPage ? ' (长截图)' : ''}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `网页截图失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserClickTool = defineTool({
  name: 'browser_click',
  description: '在网页中点击指定的按钮、链接或页面坐标（支持 CSS 选择器、包含的文本内容或 x/y 坐标定位）',
  schema: z.object({
    selector: z.string().optional().describe('目标元素的 CSS 选择器（如 button#submit、a.nav-link、.login-btn）'),
    text: z.string().optional().describe('目标元素包含的文字内容（如 "登录"、"确定"、"Submit"）'),
    x: z.number().optional().describe('点击的物理横坐标 X'),
    y: z.number().optional().describe('点击的物理纵坐标 Y'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      const res = await browser.click(args);
      return {
        content: `🖱️ 元素点击成功！\n- 当前页面标题: "${res.title}"\n- 当前网址: ${res.url}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `点击操作失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserTypeTool = defineTool({
  name: 'browser_type',
  description: '在网页输入框中键入文本（支持账号密码填写、搜索框输入，可指定是否先清空输入框及是否输入后回车）',
  schema: z.object({
    text: z.string().describe('需要填写的文本内容'),
    selector: z.string().optional().describe('目标输入框的 CSS 选择器（如 input#search、textarea[name="comment"]），缺省为当前已聚焦的输入框'),
    clearFirst: z.boolean().optional().default(true).describe('输入前是否清空原内容，缺省为 true'),
    pressEnter: z.boolean().optional().default(false).describe('输入完成后是否立即触发回车键 (Enter)，缺省为 false'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      await browser.type(args);
      return {
        content: `⌨️ 文本已成功输入${args.pressEnter ? ' 并已按下回车' : ''}！`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `文本输入失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserGetContentTool = defineTool({
  name: 'browser_get_content',
  description: '提取当前网页的纯文本内容、主要交互元素（按钮/输入框/链接清单）或 HTML 片段，辅助模型理解页面结构',
  schema: z.object({
    mode: z.enum(['text', 'elements', 'html']).optional().default('text').describe('提取模式：text(纯文本概要) / elements(可交互元素清单) / html(指定容器或整页 HTML)'),
    selector: z.string().optional().describe('可选：收窄提取范围的 CSS 选择器，例如 #main-content 或 article'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      if (args.mode === 'elements') {
        const elements = await browser.getInteractiveElements();
        const formatted = elements.map((e, idx) => {
          const label = e.text || e.placeholder || e.name || e.id || '';
          return `${idx + 1}. [${e.tag.toUpperCase()}] "${label}" → 选择器: \`${e.selector}\`${e.href ? ` (${e.href})` : ''}`;
        }).join('\n');
        return {
          content: `📋 页面可交互元素清单 (${elements.length} 项):\n\n${formatted || '（页面未检测到可交互元素）'}`,
          isError: false,
        };
      } else if (args.mode === 'html') {
        const expr = args.selector
          ? `document.querySelector(${JSON.stringify(args.selector)})?.outerHTML || ''`
          : 'document.documentElement.outerHTML';
        const html = await browser.evaluate<string>(expr);
        return {
          content: html.slice(0, 15000) + (html.length > 15000 ? '\n...[已截断]' : ''),
          isError: false,
        };
      } else {
        const text = await browser.getTextContent(args.selector);
        return {
          content: `📄 网页文本内容：\n\n${text.slice(0, 8000)}${text.length > 8000 ? '\n...[已截断]' : ''}`,
          isError: false,
        };
      }
    } catch (err) {
      return {
        content: `获取页面内容失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserEvaluateTool = defineTool({
  name: 'browser_evaluate',
  description: '在网页中执行一段自定义 JavaScript 代码并返回执行结果 JSON',
  schema: z.object({
    script: z.string().min(1).describe('要执行的 JavaScript 表达式或立即执行函数代码'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      const result = await browser.evaluate(args.script);
      return {
        content: `⚡ 脚本执行结果:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
        isError: false,
      };
    } catch (err) {
      return {
        content: `脚本执行失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserScrollTool = defineTool({
  name: 'browser_scroll',
  description: '滚动当前网页（向下、向上、回顶部或触底）',
  schema: z.object({
    direction: z.enum(['down', 'up', 'top', 'bottom']).optional().default('down').describe('滚动方向：down(向下) / up(向上) / top(顶部) / bottom(底部)'),
    amount: z.number().optional().default(600).describe('向下或向上滚动的像素量，默认 600'),
  }),
  run: async (args) => {
    try {
      const browser = BrowserController.getInstance();
      await browser.scroll(args.direction, args.amount);
      return {
        content: `📜 页面已成功向${args.direction}滚动！`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `滚动操作失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const browserCloseTool = defineTool({
  name: 'browser_close',
  description: '断开与当前自动化浏览器的连接',
  schema: z.object({}),
  run: async () => {
    try {
      const browser = BrowserController.getInstance();
      await browser.close();
      return {
        content: '🔌 已断开浏览器连接。',
        isError: false,
      };
    } catch (err) {
      return {
        content: `断开连接失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
