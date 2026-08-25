/**
 * 附件编码（FR-CHAN-013 图片/文档随任务下发）。
 *
 * 通道层已把附件落地为本地文件，这里只负责在组装请求时把它编码成
 * 各线制可接受的形态：图片转 data URL 内联，文本类文档截断后内联为正文，
 * 音频与二进制文档退化为一行路径说明（由具备相应能力的工具后续读取）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import type { Attachment } from '../domain/index.js';

/** 扩展名到 MIME 的映射，仅覆盖主流厂商实际接受的图片类型。 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 可直接内联为正文的纯文本文档扩展名。 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.log', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.sql', '.sh', '.html', '.css',
]);

/** 文档内联的字符上限，超出部分截断并注明。 */
export const DOCUMENT_INLINE_MAX_CHARS = 8000;

/** 推断附件 MIME：优先用通道给出的值，其次按扩展名兜底。 */
export function attachmentMimeType(attachment: Attachment): string {
  if (attachment.mimeType !== undefined && attachment.mimeType !== '') return attachment.mimeType;
  const ext = extname(attachment.path).toLowerCase();
  const image = IMAGE_MIME[ext];
  if (image !== undefined) return image;
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

/** 附件展示名。 */
export function attachmentLabel(attachment: Attachment): string {
  if (attachment.fileName !== undefined && attachment.fileName !== '') return attachment.fileName;
  return attachment.path;
}

/**
 * 把图片附件读为 base64。
 * 读取失败（文件已被清理等）时返回 undefined，由调用方退化为路径说明，
 * 而不是让整轮请求失败。Anthropic 线制要求裸 base64 与 media_type 分开给出，
 * OpenAI 线制要求 data URL，因此这里只提供最小公共形态。
 */
export function encodeImageBase64(attachment: Attachment): { data: string; mediaType: string } | undefined {
  if (attachment.kind !== 'image') return undefined;
  try {
    const raw = readFileSync(attachment.path);
    return { data: raw.toString('base64'), mediaType: attachmentMimeType(attachment) };
  } catch {
    return undefined;
  }
}

/** 把图片附件编码为 data URL（OpenAI 线制 image_url 形态）。 */
export function encodeImageDataUrl(attachment: Attachment): string | undefined {
  const encoded = encodeImageBase64(attachment);
  if (encoded === undefined) return undefined;
  return 'data:' + encoded.mediaType + ';base64,' + encoded.data;
}

/** 读取纯文本文档并按上限截断；非文本或读取失败返回 undefined。 */
export function readDocumentText(
  attachment: Attachment,
  maxChars: number = DOCUMENT_INLINE_MAX_CHARS,
): string | undefined {
  if (attachment.kind !== 'document') return undefined;
  const ext = extname(attachment.path).toLowerCase();
  const mime = attachmentMimeType(attachment);
  if (!TEXT_EXTENSIONS.has(ext) && !mime.startsWith('text/') && mime !== 'application/json') return undefined;
  try {
    const raw = readFileSync(attachment.path, 'utf8');
    if (raw.length <= maxChars) return raw;
    return raw.slice(0, maxChars) + '\n…（文档过长，已截断，完整内容见 ' + attachment.path + '）';
  } catch {
    return undefined;
  }
}

/** 无法内联时的一行说明，保证模型至少知道附件存在及其位置。 */
export function describeAttachment(attachment: Attachment): string {
  return '[附件 ' + attachment.kind + '] ' + attachmentLabel(attachment) + ' -> ' + attachment.path;
}
