/**
 * 浏览器自动化控制器 (BrowserController)
 *
 * 基于 Chrome DevTools Protocol (CDP) 驱动真实浏览器。
 * 优先连接本地已就绪的 Chrome/Edge，若未启动则自动唤起本地浏览器并配置独立的用户数据目录，
 * 无需额外下载 Playwright/Puppeteer 专属 Chromium 镜像。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import WebSocket from 'ws';

export interface BrowserOpenOptions {
  url?: string;
  headless?: boolean;
  width?: number;
  height?: number;
  port?: number;
}

export interface InteractiveElementInfo {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  selector: string;
  href?: string;
}

interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class BrowserController {
  private static instance: BrowserController | null = null;
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, { resolve: (res: unknown) => void; reject: (err: Error) => void }>();
  private port = 9222;
  private currentTabUrl = '';
  private currentTabTitle = '';
  private activePageWsUrl = '';

  static getInstance(): BrowserController {
    if (!BrowserController.instance) {
      BrowserController.instance = new BrowserController();
    }
    return BrowserController.instance;
  }

  /** 获取跨平台 Chrome/Edge 可执行文件路径 */
  detectBrowserExecutable(): string {
    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        `${homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ];
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
    } else if (process.platform === 'win32') {
      const localApp = process.env.LOCALAPPDATA || '';
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const candidates = [
        join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
        join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
        join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(localApp, 'Google\\Chrome\\Application\\chrome.exe'),
      ];
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
    } else {
      const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ];
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
    }
    throw new Error('未在当前系统中检测到已安装的 Google Chrome、Edge 或 Chromium 浏览器。');
  }

  /** 检查指定端口是否已启动 CDP */
  async isPortReady(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 确保浏览器就绪并连接 WebSocket */
  async ensureBrowser(options: BrowserOpenOptions = {}): Promise<{ url: string; title: string }> {
    this.port = options.port ?? 9222;
    const isReady = await this.isPortReady(this.port);

    if (!isReady) {
      const executable = this.detectBrowserExecutable();
      const profileDir = join(homedir(), '.hap', 'browser-profile');
      if (!existsSync(profileDir)) {
        mkdirSync(profileDir, { recursive: true });
      }

      const width = options.width ?? 1280;
      const height = options.height ?? 800;
      const headless = options.headless === true;

      const args = [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-popup-blocking',
        '--disable-sync',
        '--disable-translate',
        `--window-size=${width},${height}`,
        ...(headless ? ['--headless=new'] : []),
        options.url || 'about:blank',
      ];

      const child = execa(executable, args, { detached: true, stdio: 'ignore' });
      (child as unknown as { unref?: () => void }).unref?.();

      // 轮询等待 CDP 服务启动
      const startTime = Date.now();
      let ready = false;
      while (Date.now() - startTime < 10000) {
        await new Promise((r) => setTimeout(r, 400));
        if (await this.isPortReady(this.port)) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        throw new Error(`浏览器已尝试唤起，但在 10 秒内未能在端口 ${this.port} 响应调试服务。`);
      }
    }

    // 获取当前活动 Tab
    await this.connectToActivePage(options.url);
    return {
      url: this.currentTabUrl,
      title: this.currentTabTitle,
    };
  }

  /** 连接到现有或新打开的页面 Tab */
  private async connectToActivePage(targetUrl?: string): Promise<void> {
    const listRes = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    const pages = (await listRes.json()) as Array<{
      id: string;
      title: string;
      url: string;
      webSocketDebuggerUrl?: string;
      type: string;
    }>;

    const pageTabs = pages.filter((p) => p.type === 'page' && p.webSocketDebuggerUrl);
    let chosen = pageTabs[0];

    if (!chosen) {
      const newUrl = targetUrl ? `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(targetUrl)}` : `http://127.0.0.1:${this.port}/json/new`;
      const newRes = await fetch(newUrl, { method: 'PUT' });
      chosen = (await newRes.json()) as typeof chosen;
    }

    if (!chosen || !chosen.webSocketDebuggerUrl) {
      throw new Error('未能在本地浏览器找到可连接的网页 Tab。');
    }

    if (this.activePageWsUrl !== chosen.webSocketDebuggerUrl || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connectWebSocket(chosen.webSocketDebuggerUrl);
      this.activePageWsUrl = chosen.webSocketDebuggerUrl;
    }

    this.currentTabUrl = chosen.url;
    this.currentTabTitle = chosen.title;

    if (targetUrl && targetUrl !== 'about:blank' && this.currentTabUrl !== targetUrl) {
      await this.navigate(targetUrl);
    }
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('连接浏览器 WebSocket 协议超时'));
      }, 5000);

      ws.on('open', async () => {
        clearTimeout(timer);
        this.ws = ws;
        try {
          await this.send('Page.enable');
          await this.send('DOM.enable');
          await this.send('Runtime.enable');
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(data.toString()) as CdpResponse;
          if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
            const entry = this.pendingRequests.get(parsed.id)!;
            this.pendingRequests.delete(parsed.id);
            if (parsed.error) {
              entry.reject(new Error(`CDP 错误 (${parsed.error.code}): ${parsed.error.message}`));
            } else {
              entry.resolve(parsed.result);
            }
          }
        } catch {
          // 忽略格式异常
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  /** 发送 CDP JSON-RPC 请求 */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.ensureBrowser();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('与浏览器的通信链路未连接');
    }

    const id = ++this.messageId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (res) => resolve(res as T),
        reject,
      });
      const payload = JSON.stringify({ id, method, params });
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /** 在页面上下文中执行 JavaScript 表达式 */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`页面脚本执行异常: ${msg}`);
    }
    return res.result?.value as T;
  }

  /** 导航到指定网址 */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    let target = url.trim();
    if (!/^https?:\/\//i.test(target) && !/^file:\/\//i.test(target) && !/^about:/i.test(target)) {
      target = 'https://' + target;
    }

    await this.send('Page.navigate', { url: target });
    // 等待网页 DOM 完成加载
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const state = await this.evaluate<string>('document.readyState');
        if (state === 'interactive' || state === 'complete') {
          break;
        }
      } catch {
        // 容错重试
      }
    }

    this.currentTabTitle = (await this.evaluate<string>('document.title')) || '';
    this.currentTabUrl = (await this.evaluate<string>('window.location.href')) || target;
    return { url: this.currentTabUrl, title: this.currentTabTitle };
  }

  /** 截取当前网页截图并持久化为图片文件 */
  async screenshot(options: { fullPage?: boolean; outputPath: string }): Promise<{ path: string; width: number; height: number }> {
    if (!this.ws) await this.ensureBrowser();

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (options.fullPage) {
      const metrics = await this.evaluate<{ width: number; height: number }>(`({
        width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, window.innerWidth),
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight),
      })`);
      if (metrics) {
        clip = { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 };
      }
    }

    const res = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    });

    const buffer = Buffer.from(res.data, 'base64');
    writeFileSync(options.outputPath, buffer);

    const dims = await this.evaluate<{ width: number; height: number }>(`({
      width: window.innerWidth,
      height: window.innerHeight
    })`);

    return {
      path: options.outputPath,
      width: dims?.width || 1280,
      height: dims?.height || 800,
    };
  }

  /** 点击指定元素或坐标 */
  async click(options: { selector?: string | undefined; text?: string | undefined; x?: number | undefined; y?: number | undefined }): Promise<{ success: boolean; url: string; title: string }> {
    if (options.x !== undefined && options.y !== undefined) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: options.x,
        y: options.y,
        button: 'left',
        clickCount: 1,
      });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: options.x,
        y: options.y,
        button: 'left',
        clickCount: 1,
      });
    } else if (options.selector || options.text) {
      const script = `
        (() => {
          let el = null;
          ${options.selector ? `el = document.querySelector(${JSON.stringify(options.selector)});` : ''}
          if (!el && ${JSON.stringify(Boolean(options.text))}) {
            const targetText = ${JSON.stringify(options.text?.trim() || '')}.toLowerCase();
            const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], span, div'));
            el = candidates.find(c => (c.innerText || c.textContent || '').trim().toLowerCase().includes(targetText));
          }
          if (!el) return false;
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.click();
          return true;
        })()
      `;
      const clicked = await this.evaluate<boolean>(script);
      if (!clicked) {
        throw new Error(`未能在当前页面找到匹配的元素：${options.selector || options.text}`);
      }
    } else {
      throw new Error('click 操作必须提供 selector、text 或 (x, y) 坐标之一。');
    }

    await new Promise((r) => setTimeout(r, 600));
    this.currentTabTitle = (await this.evaluate<string>('document.title')) || '';
    this.currentTabUrl = (await this.evaluate<string>('window.location.href')) || '';
    return { success: true, url: this.currentTabUrl, title: this.currentTabTitle };
  }

  /** 表单填写与键盘输入 */
  async type(options: { selector?: string | undefined; text: string; clearFirst?: boolean | undefined; pressEnter?: boolean | undefined }): Promise<{ success: boolean }> {
    const selector = options.selector || 'input:focus, textarea:focus';
    const clearFirst = options.clearFirst !== false;
    const textToType = options.text;

    const script = `
      (() => {
        let el = document.querySelector(${JSON.stringify(selector)});
        if (!el) {
          const focused = document.activeElement;
          if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
            el = focused;
          }
        }
        if (!el) return false;
        el.focus();
        if (${JSON.stringify(clearFirst)}) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.value = (el.value || '') + ${JSON.stringify(textToType)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `;

    const success = await this.evaluate<boolean>(script);
    if (!success) {
      throw new Error(`未能在当前页面定位到可输入的表单元素：${selector}`);
    }

    if (options.pressEnter) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await new Promise((r) => setTimeout(r, 600));
    }

    return { success: true };
  }

  /** 提取网页可交互元素清单（供模型分析下一步操作） */
  async getInteractiveElements(): Promise<InteractiveElementInfo[]> {
    const script = `
      (() => {
        const results = [];
        const seen = new Set();
        const nodes = document.querySelectorAll('button, a, input, select, textarea, [role="button"]');

        for (const el of Array.from(nodes).slice(0, 80)) {
          if (!el || el.offsetParent === null) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          let selector = '';
          if (el.id) selector = '#' + CSS.escape(el.id);
          else if (el.getAttribute('name')) selector = el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
          else if (el.className && typeof el.className === 'string') {
            const firstClass = el.className.split(/\\s+/).filter(Boolean)[0];
            if (firstClass) selector = el.tagName.toLowerCase() + '.' + CSS.escape(firstClass);
          }
          if (!selector) selector = el.tagName.toLowerCase();

          const key = el.tagName + '|' + (el.id || '') + '|' + (el.innerText || '');
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || undefined,
            id: el.id || undefined,
            name: el.getAttribute('name') || undefined,
            text: (el.innerText || el.textContent || '').trim().slice(0, 60) || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            selector,
            href: el.getAttribute('href') || undefined,
          });
        }
        return results;
      })()
    `;
    return await this.evaluate<InteractiveElementInfo[]>(script);
  }

  /** 提取当前页面的核心纯文本内容 */
  async getTextContent(selector?: string): Promise<string> {
    const expr = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`
      : `document.body?.innerText || ''`;
    const text = await this.evaluate<string>(expr);
    return (text || '').replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }

  /** 页面滚动 */
  async scroll(direction: 'down' | 'up' | 'top' | 'bottom', amount = 600): Promise<void> {
    let script = '';
    switch (direction) {
      case 'down':
        script = `window.scrollBy({ top: ${amount}, behavior: 'instant' })`;
        break;
      case 'up':
        script = `window.scrollBy({ top: -${amount}, behavior: 'instant' })`;
        break;
      case 'top':
        script = "window.scrollTo({ top: 0, behavior: 'instant' })";
        break;
      case 'bottom':
        script = "window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })";
        break;
    }
    await this.evaluate(script);
    await new Promise((r) => setTimeout(r, 300));
  }

  /** 关闭当前 WebSocket 连接 */
  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
  }
}
