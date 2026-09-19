import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WeChatVisionParseResult } from './vision-parser.js';

function runCmd(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export interface OcrRecognizedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isTitle?: boolean;
}

/** 获取并保证本地 macos_ocr 原生可执行文件就绪 */
export function ensureMacOcrBinary(): string | undefined {
  if (process.platform !== 'darwin') return undefined;

  const binPath = join(process.cwd(), 'bin', 'macos_ocr');
  if (existsSync(binPath)) {
    return binPath;
  }

  const srcPath = join(process.cwd(), 'src', 'channels', 'wechat', 'desktop-vision', 'macos_ocr.m');
  if (existsSync(srcPath)) {
    try {
      execFileSync('mkdir', ['-p', join(process.cwd(), 'bin')]);
      execFileSync('clang', [
        '-O2',
        '-fmodules',
        '-framework', 'Foundation',
        '-framework', 'Vision',
        '-framework', 'CoreGraphics',
        '-framework', 'ImageIO',
        srcPath,
        '-o', binPath,
      ]);
      if (existsSync(binPath)) {
        return binPath;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** 解析本地 OCR 识别出来的 WeChat 窗口文本序列，提取活跃会话与待回复消息 */
export function parseWeChatOcrItems(items: OcrRecognizedItem[]): WeChatVisionParseResult {
  if (!items || items.length === 0) {
    return {
      ok: true,
      hasWeChatWindow: false,
      needsReply: false,
      summary: '未识别到有效文字',
    };
  }

  // 1. 检验是否为微信界面
  const hasWeChatSigns = items.some((i) =>
    /微信|搜索|通讯录|收藏|朋友圈|文件传输|微信支付|微信游戏/i.test(i.text)
  );

  // 2. 尝试从聊天标题栏提取当前激活会话标题 (优先采用阶段2标题栏独立OCR切片)
  const explicitTitle = items.find((i) => i.isTitle && i.text.trim().length > 0);
  const titleCandidate = explicitTitle || items.find((i) =>
    i.x >= 0.32 && i.x <= 0.75 && i.y >= 0.86 &&
    !/^[Q\s]*搜索$|^日、|^凶$|^这$|^口$|^8、白$|^⑨$|^［\d+条］/.test(i.text.trim())
  );
  let chatTarget = titleCandidate?.text?.trim() || '';

  // 3. 收集聊天视窗内部的消息气泡 (x >= 0.38, y < 0.88, y > 0.12)
  const chatMessages: Array<{
    text: string;
    x: number;
    y: number;
    isFromMe: boolean;
  }> = [];

  for (const item of items) {
    if (item.isTitle) continue;
    const text = item.text.trim();
    if (!text) continue;

    // 过滤时间戳行 (如 23:02, 17:42, 22:47)
    if (/^\d{1,2}[:：\-]\d{2}$/.test(text)) continue;
    // 过滤单个杂项符号
    if (/^[日、凶这口⑨×…]$/.test(text)) continue;
    // 过滤调试标记与统计行（模型、用量、任务ID等）
    if (/^(?:[—\-_]{3,}|🤖|📊|🆔|任务[：:]|[0-9a-f]{8}$|tokens)/i.test(text)) continue;

    // 聊天消息气泡区域
    if (item.x >= 0.38 && item.y < 0.88 && item.y > 0.12) {
      // 在微信聊天视窗中：
      // 左侧对方/来信气泡通常位于 x: 0.40 - 0.65
      // 右侧我方发出绿色气泡通常位于 x: 0.70 - 0.95
      const isFromMe = item.x >= 0.70;
      chatMessages.push({
        text,
        x: item.x,
        y: item.y,
        isFromMe,
      });
    }
  }

  // 4. 从左侧会话列表 (x: 0.12 - 0.35) 提取未读会话与最新来信
  let listTarget = '';
  let listPreview = '';
  let listUnreadCount = 0;

  const listItems = items.filter((i) => !i.isTitle && i.x >= 0.12 && i.x <= 0.35 && i.y < 0.88 && i.y > 0.12);
  listItems.sort((a, b) => b.y - a.y);

  let listTargetCoords: [number, number] | undefined;
  for (const li of listItems) {
    const text = li.text.trim();
    if (/^[Q\s]*搜索$/.test(text)) continue;

    const unreadMatch = text.match(/［(\d+)条］/);
    if (unreadMatch) {
      listUnreadCount = parseInt(unreadMatch[1] || '1', 10);
    }

    if (!listTarget && !/［\d+条］/.test(text) && !/^\d{1,2}:\d{2}$/.test(text)) {
      listTarget = text;
      listTargetCoords = [li.x, li.y];
    } else if (listTarget && !listPreview && !/^\d{1,2}:\d{2}$/.test(text) && text !== listTarget) {
      listPreview = text.replace(/［\d+条］/, '').trim();
      break;
    }
  }

  // 如果聊天视窗有消息，按 Apple Vision 坐标系排序：
  // y 越大代表越靠上 (较早发出的消息)，y 越小代表越靠下 (最新收发的消息)
  chatMessages.sort((a, b) => b.y - a.y);
  const latestMessage = chatMessages[chatMessages.length - 1];

  const target = chatTarget || listTarget || '微信对话';

  if (latestMessage) {
    const isFromMe = latestMessage.isFromMe;
    const cleanText = latestMessage.text;

    // 智能回复触发判定：
    // 1. 当前聊天视窗内最新消息是对方发来的 (!isFromMe)
    if (!isFromMe && cleanText.length > 0) {
      return {
        ok: true,
        hasWeChatWindow: hasWeChatSigns || Boolean(chatTarget || listTarget),
        chatTarget: target,
        isGroup: target.includes('(') || target.includes('（') || target.includes('群'),
        lastMessage: {
          sender: target,
          isFromMe: false,
          text: cleanText,
        },
        needsReply: true,
        summary: `收到来自 [${target}] 的新消息：“${cleanText}”，需智能体自动回复`,
        rawResponse: JSON.stringify(items),
      };
    }

    // 2. 当前视窗内最新消息由我方已发送完毕 (isFromMe 为 true)
    // 但会话列表顶部有其他好友发来的新消息（例如 [我] 发来 "请回复"）
    if (listTarget && listPreview && listTarget !== target) {
      return {
        ok: true,
        hasWeChatWindow: true,
        chatTarget: listTarget,
        chatTargetCoords: listTargetCoords,
        isGroup: listTarget.includes('(') || listTarget.includes('（') || listTarget.includes('群'),
        lastMessage: {
          sender: listTarget,
          isFromMe: false,
          text: listPreview,
        },
        needsReply: true,
        summary: `当前会话 [${target}] 我方已发；会话列表检测到 [${listTarget}] 待处理新来信：“${listPreview}”，准备自动切换代答`,
        rawResponse: JSON.stringify(items),
      };
    }

    // 3. 当前会话我方已发，且列表中暂无其他好友新来信
    return {
      ok: true,
      hasWeChatWindow: hasWeChatSigns || Boolean(chatTarget || listTarget),
      chatTarget: target,
      isGroup: target.includes('(') || target.includes('（') || target.includes('群'),
      lastMessage: {
        sender: '我',
        isFromMe: true,
        text: cleanText,
      },
      needsReply: false,
      summary: `当前会话 [${target}] 最新消息由我方刚刚发送（“${cleanText}”），无需重复答复`,
      rawResponse: JSON.stringify(items),
    };
  }

  if (listTarget && listPreview) {
    // 视窗空白但左侧列表有待处理消息
    return {
      ok: true,
      hasWeChatWindow: true,
      chatTarget: listTarget,
      chatTargetCoords: listTargetCoords,
      isGroup: listTarget.includes('(') || listTarget.includes('（') || listTarget.includes('群'),
      lastMessage: {
        sender: listTarget,
        isFromMe: false,
        text: listPreview,
      },
      needsReply: true,
      summary: `会话列表检测到 [${listTarget}] 待处理新消息：“${listPreview}”`,
      rawResponse: JSON.stringify(items),
    };
  }

  return {
    ok: true,
    hasWeChatWindow: hasWeChatSigns || Boolean(chatTarget),
    chatTarget: target || '',
    needsReply: false,
    summary: '已识别到微信界面，当前会话暂无未处理新消息',
    rawResponse: JSON.stringify(items),
  };
}

/**
 * 使用 macOS 苹果原生高精度 Vision OCR（零 Token 消耗、~50ms 极速、纯本地隐私无泄漏）
 */
export async function parseWeChatScreenViaOcr(
  imageInput: Buffer | string
): Promise<WeChatVisionParseResult> {
  const ocrBin = ensureMacOcrBinary();
  if (!ocrBin) {
    return {
      ok: false,
      hasWeChatWindow: false,
      needsReply: false,
      error: '本地原生 macOS OCR 引擎未就绪 (仅支持 macOS 系统)',
    };
  }

  let tempPath: string | undefined;
  try {
    let filePath: string;
    if (typeof imageInput === 'string' && existsSync(imageInput)) {
      filePath = imageInput;
    } else {
      tempPath = join(tmpdir(), `hap_ocr_${Date.now()}_${randomUUID().slice(0, 6)}.png`);
      const buffer = typeof imageInput === 'string'
        ? Buffer.from(imageInput.replace(/^data:image\/\w+;base64,/, ''), 'base64')
        : imageInput;
      writeFileSync(tempPath, buffer);
      filePath = tempPath;
    }

    const { stdout } = await runCmd(ocrBin, [filePath]);
    const items = JSON.parse(stdout.trim() || '[]') as OcrRecognizedItem[];
    return parseWeChatOcrItems(items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      hasWeChatWindow: false,
      needsReply: false,
      error: `本地原生 OCR 解析失败: ${msg}`,
    };
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}
