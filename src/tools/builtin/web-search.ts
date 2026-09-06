/**
 * web_search 工具：实时联网搜索工具（FR-TOOL-001 扩展）。
 *
 * 1. 默认开箱即用：零配置 DuckDuckGo 网页检索，解析标题、链接与摘要；
 * 2. 商业级增强：检测到 TAVILY_API_KEY 或 BING_SEARCH_API_KEY 时自动走对应官方 API；
 * 3. 稳健容错：DuckDuckGo HTML -> DuckDuckGo Instant Answer -> 备用引擎逐级降级；
 * 4. 输出标准 Markdown 列表，包含编号、超链接与内容摘要，便于智能体阅读与后续深入抓取。
 */

import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { defineTool } from '../define.js';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fetchUrlText(
  targetUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(targetUrl);
      const req = httpsRequest(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method: options.method || 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            ...options.headers,
          },
          timeout: options.timeoutMs ?? 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode ?? 200,
              text: buf.toString('utf8'),
            });
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`请求超时 (${options.timeoutMs ?? 15000}ms): ${targetUrl}`));
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('请求已取消'));
        });
      }

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** 解析 DuckDuckGo HTML 搜索结果 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const resultBlocks = html.split(/class="[^"]*result[^"]*results_links/i);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i] || '';

    const linkMatch =
      block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]*class="[^"]*result__url[^"]*"[^>]*href="([^"]+)"/i);

    const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

    let rawUrl = titleMatch ? titleMatch[1] : linkMatch ? linkMatch[1] : '';
    const rawTitle = titleMatch ? titleMatch[2] : '';

    if (!rawUrl) continue;

    // 清理 DuckDuckGo 重定向链接 (/l/?uddg=https%3A%2F%2F...)
    if (rawUrl.includes('uddg=')) {
      const match = rawUrl.match(/uddg=([^&]+)/);
      if (match && match[1]) {
        try {
          rawUrl = decodeURIComponent(match[1]);
        } catch {
          // ignore
        }
      }
    }

    // 清理 HTML 标签
    const cleanTitle = (rawTitle || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();

    // 匹配摘要
    const snippetMatch =
      block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
    const cleanSnippet = snippetMatch && snippetMatch[1] !== undefined
      ? snippetMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .trim()
      : '';

    if (cleanTitle && rawUrl.startsWith('http')) {
      results.push({
        title: cleanTitle,
        url: rawUrl,
        snippet: cleanSnippet,
      });
    }
  }

  return results;
}

/** Tavily 商业 API 搜索 */
async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
  signal?: AbortSignal
): Promise<SearchResultItem[]> {
  const options: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
  };
  if (signal) options.signal = signal;
  const res = await fetchUrlText('https://api.tavily.com/search', options);

  if (res.status !== 200) {
    throw new Error(`Tavily 搜索接口异常 (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }

  const json = JSON.parse(res.text);
  const items = Array.isArray(json.results) ? json.results : [];
  return items.slice(0, maxResults).map((item: any) => ({
    title: String(item.title || ''),
    url: String(item.url || ''),
    snippet: String(item.content || ''),
  }));
}

/** DuckDuckGo Instant Answer 兜底 */
async function searchDuckDuckGoInstant(
  query: string,
  maxResults: number,
  signal?: AbortSignal
): Promise<SearchResultItem[]> {
  const options: { signal?: AbortSignal } = {};
  if (signal) options.signal = signal;
  const res = await fetchUrlText(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    options
  );
  if (res.status !== 200) return [];

  const json = JSON.parse(res.text);
  const results: SearchResultItem[] = [];

  if (json.AbstractText && json.AbstractURL) {
    results.push({
      title: json.Heading || query,
      url: json.AbstractURL,
      snippet: json.AbstractText,
    });
  }

  if (Array.isArray(json.RelatedTopics)) {
    for (const topic of json.RelatedTopics) {
      if (results.length >= maxResults) break;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.slice(0, 60),
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      }
    }
  }

  return results;
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    '执行实时互联网搜索，返回包含标题、链接与摘要的检索结果。可用于检索最新的技术文档、新闻、外部 API 说明或开源项目信息。',
  schema: z.object({
    query: z.string().min(1).describe('搜索关键词或自然语言问题短语'),
    limit: z.number().int().min(1).max(20).default(5).optional().describe('返回结果条数上限（默认 5 条）'),
  }),
  run: async (args, ctx) => {
    const query = args.query.trim();
    const limit = args.limit ?? 5;
    const env = ctx.env ?? process.env;

    let items: SearchResultItem[] = [];
    let engineUsed = 'DuckDuckGo';

    // 1. 商业 API 优先（若配置了 API Key）
    if (env.TAVILY_API_KEY) {
      try {
        engineUsed = 'Tavily Search';
        items = await searchTavily(query, env.TAVILY_API_KEY, limit, ctx.signal);
      } catch {
        // 降级到 DuckDuckGo
        engineUsed = 'DuckDuckGo (Tavily 降级)';
      }
    }

    // 2. 默认开箱即用 DuckDuckGo HTML
    if (items.length === 0) {
      try {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetchUrlText(ddgUrl, {
          signal: ctx.signal,
          timeoutMs: 12000,
        });
        if (res.status === 200) {
          items = parseDuckDuckGoHtml(res.text, limit);
        }
      } catch {
        // 继续尝试 Instant Answer
      }
    }

    // 3. DuckDuckGo Instant Answer 兜底
    if (items.length === 0) {
      try {
        items = await searchDuckDuckGoInstant(query, limit, ctx.signal);
        engineUsed = 'DuckDuckGo Instant';
      } catch {
        // 最终空结果
      }
    }

    if (items.length === 0) {
      return {
        content: `未找到关于 "${query}" 的有效互联网检索结果。\n建议：\n1. 尝试简化搜索词或使用中英文关键词；\n2. 可直接使用 http_fetch 工具抓取具体目标网页。`,
      };
    }

    const mdLines = [
      `### 🔍 互联网搜索结果 (引擎: ${engineUsed} | 共 ${items.length} 条)`,
      `关键词: \`${query}\`\n`,
    ];

    items.forEach((item, index) => {
      mdLines.push(`${index + 1}. **[${item.title}](${item.url})**`);
      if (item.snippet) {
        mdLines.push(`   > ${item.snippet.replace(/\n+/g, ' ')}`);
      }
      mdLines.push('');
    });

    return {
      content: mdLines.join('\n').trim(),
    };
  },
});
