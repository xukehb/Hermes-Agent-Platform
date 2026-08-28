/**
 * AI 图像生成工具 (Image Generation Tool)
 * 支持基于 DALL-E 3、OpenAI 兼容生图接口以及高画质免 Key AI 生图引擎。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../define.js';

export const generateImageSchema = z.object({
  prompt: z.string().describe('图像生成的详细提示词 (Prompt)，支持中英文描述画面细节、主体、光影与艺术风格'),
  size: z.enum(['1024x1024', '512x512', '1024x1792', '1792x1024']).default('1024x1024').describe('输出分辨率'),
  aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).default('1:1').describe('图像宽高比'),
  style: z.enum(['vivid', 'natural', 'anime', 'digital-art', 'photorealistic']).default('vivid').describe('艺术风格'),
  outputFileName: z.string().optional().describe('自定义输出文件名，如 logo.png 或 diagram.png，默认自动按时间戳生成'),
});

export const generateImageTool = defineTool({
  name: 'generate_image',
  description: '根据文本描述生成高质量 AI 图像，支持插画、架构概念图、UI 设计图、壁纸与摄影写实，自动将图片保存至工作区并返回 Markdown 图片展示',
  schema: generateImageSchema,
  run: async (args, ctx) => {
    const prompt = args.prompt.trim();
    if (!prompt) {
      return { content: '错误：提示词 (prompt) 不能为空', isError: true };
    }

    const workspace = ctx.agent.workspace || process.cwd();
    const imagesDir = join(workspace, 'generated_images');
    if (!existsSync(imagesDir)) {
      mkdirSync(imagesDir, { recursive: true });
    }

    const timestamp = Date.now();
    const fileName = (args.outputFileName || `image_${timestamp}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const localFilePath = resolve(imagesDir, fileName);

    let width = 1024;
    let height = 1024;
    if (args.size === '512x512') { width = 512; height = 512; }
    else if (args.size === '1024x1792' || args.aspectRatio === '9:16') { width = 1024; height = 1792; }
    else if (args.size === '1792x1024' || args.aspectRatio === '16:9') { width = 1792; height = 1024; }
    else if (args.aspectRatio === '4:3') { width = 1024; height = 768; }
    else if (args.aspectRatio === '3:4') { width = 768; height = 1024; }

    // 1. 尝试检测当前工作区配置的 DALL-E / OpenAI 生图端点
    let imageUrl = '';
    const openAiKey = process.env.OPENAI_API_KEY;
    const openAiBase = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    if (openAiKey) {
      try {
        const cleanBase = openAiBase.replace(/\/+$/, '');
        const endpoint = cleanBase.endsWith('/v1') ? `${cleanBase}/images/generations` : `${cleanBase}/v1/images/generations`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            prompt,
            model: 'dall-e-3',
            n: 1,
            size: args.size || '1024x1024',
          }),
        });

        if (res.ok) {
          const data = await res.json() as { data?: Array<{ url?: string; b64_json?: string }> };
          if (data.data?.[0]?.url) {
            imageUrl = data.data[0].url;
          } else if (data.data?.[0]?.b64_json) {
            const buf = Buffer.from(data.data[0].b64_json, 'base64');
            writeFileSync(localFilePath, buf);
            const normPath = localFilePath.replace(/\\/g, '/');
            return {
              content: `🎉 图像已成功由 DALL-E 3 生成并保存！\n\n![${prompt}](file:///${normPath})\n\n- 本地文件路径: \`${localFilePath}\`\n- 分辨率: ${width}x${height}`,
              isError: false,
            };
          }
        }
      } catch {
        // 容错回退
      }
    }

    // 2. 免 Key 高画质 Pollinations AI Flux / SDXL 引擎
    if (!imageUrl) {
      const encodedPrompt = encodeURIComponent(`${prompt}, ${args.style || 'vivid'} style, high quality, masterpiece, detailed`);
      imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true&seed=${timestamp % 100000}`;
    }

    // 3. 下载图片持久化到本地工作区
    try {
      const imgRes = await fetch(imageUrl, { method: 'GET' });
      if (imgRes.ok) {
        const arrayBuf = await imgRes.arrayBuffer();
        writeFileSync(localFilePath, Buffer.from(arrayBuf));
      }
    } catch {
      // 容错使用在线直链
    }

    const normPath = localFilePath.replace(/\\/g, '/');
    const localUri = existsSync(localFilePath) ? `file:///${normPath}` : imageUrl;

    return {
      content: `🎉 图像已成功生成！\n\n![${prompt}](${localUri})\n\n- 画面描述: "${prompt}"\n- 分辨率: ${width}x${height} (${args.aspectRatio})\n- 本地存储: \`${localFilePath}\``,
      isError: false,
    };
  },
});
