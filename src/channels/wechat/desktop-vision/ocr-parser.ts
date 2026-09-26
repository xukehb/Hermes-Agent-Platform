import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { WeChatVisionParseResult } from './vision-parser.js';
import { normalizeContactName, isGarbageContactName } from '../../contacts-store.js';

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

  let currentDir = '';
  try {
    currentDir = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  } catch {}

  const persistentHomeBin = join(homedir(), '.hap', 'bin', 'macos_ocr');

  // 1. 优先多路径查找现有编译好的可执行文件
  const candidates = [
    process.env.HAP_MACOS_OCR_BIN,
    persistentHomeBin,
    (process as any).resourcesPath ? join((process as any).resourcesPath, 'bin', 'macos_ocr') : undefined,
    currentDir ? join(currentDir, '..', '..', '..', '..', 'bin', 'macos_ocr') : undefined,
    currentDir ? join(currentDir, '..', '..', 'bin', 'macos_ocr') : undefined,
    join(process.cwd(), 'bin', 'macos_ocr'),
    '/Applications/Hermes Agent Platform.app/Contents/Resources/bin/macos_ocr',
  ].filter((p): p is string => Boolean(p));

  for (const binPath of candidates) {
    if (existsSync(binPath)) {
      // 自动镜像一份至 ~/.hap/bin/macos_ocr，保证在各工作目录、Electron 及子进程下均能绝对路径稳定调用
      if (binPath !== persistentHomeBin) {
        try {
          mkdirSync(join(homedir(), '.hap', 'bin'), { recursive: true });
          copyFileSync(binPath, persistentHomeBin);
          chmodSync(persistentHomeBin, 0o755);
        } catch {}
      }
      return binPath;
    }
  }

  // 2. 若未找到预编译二进制，尝试从源码自动编译至 ~/.hap/bin/macos_ocr
  const srcCandidates = [
    currentDir ? join(currentDir, 'macos_ocr.m') : undefined,
    join(process.cwd(), 'src', 'channels', 'wechat', 'desktop-vision', 'macos_ocr.m'),
  ].filter((p): p is string => Boolean(p));

  for (const srcPath of srcCandidates) {
    if (existsSync(srcPath)) {
      try {
        mkdirSync(join(homedir(), '.hap', 'bin'), { recursive: true });
        execFileSync('clang', [
          '-O2',
          '-fmodules',
          '-framework', 'Foundation',
          '-framework', 'Vision',
          '-framework', 'CoreGraphics',
          '-framework', 'ImageIO',
          srcPath,
          '-o', persistentHomeBin,
        ]);
        if (existsSync(persistentHomeBin)) {
          chmodSync(persistentHomeBin, 0o755);
          return persistentHomeBin;
        }
      } catch {
        // ignore compile failure
      }
    }
  }

  return undefined;
}

export interface ChatBubble {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isFromMe: boolean;
  lines: OcrRecognizedItem[];
}

/** 计算两个字符串的编辑距离相似度 (0.0 ~ 1.0) */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  if (longer.includes(shorter)) return shorter.length / longer.length;

  const m = longer.length;
  const n = shorter.length;
  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const charA = longer[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = charA === shorter[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,
        prevRow[j] + 1,
        prevRow[j - 1] + cost
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return (m - prevRow[n]) / m;
}

/** 智能归一化与子串/模糊回音匹配：严格判断某段识别文本是否属于我方最近发送的回复 */
export function isTextSentByMe(text: string, knownSentTexts?: Set<string>): boolean {
  if (!knownSentTexts || knownSentTexts.size === 0 || !text) return false;
  const rawClean = text.trim();
  if (knownSentTexts.has(rawClean)) return true;

  // 消除标点、表情、空白符号后的纯字面比对
  const normTarget = rawClean.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!normTarget) return false;

  for (const sent of knownSentTexts) {
    const s = sent.trim();
    if (s === rawClean) return true;
    const normSent = s.replace(/[\s\p{P}\p{S}]/gu, '');
    if (!normSent) continue;
    if (normSent === normTarget) return true;

    // 核心防护：我方长文本回复被 OCR 切行时的片段比对
    // 1) 首尾行断句比对（末尾断句长度 >= 2 如“出题～”、“定～”，头部断句长度 >= 3）
    if (normTarget.length >= 2 && normSent.endsWith(normTarget)) return true;
    if (normTarget.length >= 3 && normSent.startsWith(normTarget)) return true;
    // 2) 中间片段比对：必须要求片段足够长（>= 6 字符），防止把“好的”、“在吗”等通用短语误杀
    if (normTarget.length >= 6 && normSent.includes(normTarget)) return true;
    if (normSent.length >= 6 && normTarget.includes(normSent)) return true;

    // 3) 整句/分句级模糊编辑距离匹配：解决屏幕 OCR 错别字导致 AI 误读自己并循环代答的问题
    // (例如 "披奇提有点不好题思了" 对应 "被夸得有点不好意思了"；"被考得有点不好意思了" 对应 "被夸得有点不好意思了")
    if (normTarget.length >= 4 && normSent.length >= 4) {
      if (textSimilarity(normTarget, normSent) >= 0.65) return true;

      // 按句号/感叹号/问号/换行拆分子句独立比对
      const sentParts = sent
        .split(/[。！？!?\n\r]+/)
        .map((p) => p.replace(/[\s\p{P}\p{S}]/gu, ''))
        .filter((p) => p.length >= 4);

      for (const part of sentParts) {
        if (textSimilarity(normTarget, part) >= 0.65) return true;
      }
    }
  }

  return false;
}

/**
 * 气泡聚类算法 (Bubble Clustering)：
 * 微信多行气泡内部各行垂直间距极小 (deltaY <= 0.045)，但气泡内各行常呈左对齐排列。
 * 单独看气泡末尾的短行（如“定～”、“出题～”）时，其右边缘常 < 0.70，导致被误判为对方来信！
 * 聚类算法将相邻行聚合成完整气泡：只要该气泡中有任意一行靠右 (rightEdge >= 0.70 或 x >= 0.65)，
 * 或者匹配了我方发送记录，整个气泡及其所有行均判定为我方发出 (isFromMe = true)！
 */
export function clusterChatBubbles(
  items: OcrRecognizedItem[],
  knownSentTexts?: Set<string>
): ChatBubble[] {
  if (items.length === 0) return [];

  // 按 Apple Vision 坐标系降序排列 (y 越大越靠视窗上方，从上往下聚类)
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const first = sorted[0];
  if (!first) return [];
  const bubbles: ChatBubble[] = [];
  let currentCluster: OcrRecognizedItem[] = [first];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) continue;
    const deltaY = prev.y - curr.y;

    const prevRightEdge = prev.x + prev.width;
    const currRightEdge = curr.x + curr.width;
    const isSameSenderSide =
      Math.abs(prev.x - curr.x) < 0.08 ||
      (prevRightEdge >= 0.70 && currRightEdge >= 0.70) ||
      (prevRightEdge >= 0.70 && curr.x >= 0.40) ||
      (prev.x < 0.55 && curr.x < 0.55);

    if (deltaY >= 0 && deltaY <= 0.048 && isSameSenderSide) {
      currentCluster.push(curr);
    } else {
      bubbles.push(finalizeBubble(currentCluster, knownSentTexts));
      currentCluster = [curr];
    }
  }

  if (currentCluster.length > 0) {
    bubbles.push(finalizeBubble(currentCluster, knownSentTexts));
  }

  return bubbles;
}

function finalizeBubble(lines: OcrRecognizedItem[], knownSentTexts?: Set<string>): ChatBubble {
  const combinedText = lines.map((l) => l.text.trim()).filter(Boolean).join('');
  const minX = Math.min(...lines.map((l) => l.x));
  const maxX = Math.max(...lines.map((l) => l.x + l.width));
  const minY = Math.min(...lines.map((l) => l.y));
  const maxY = Math.max(...lines.map((l) => l.y + l.height));

  // 1. 命中我方历史发送指纹库 (含模糊错别字容错)
  const matchesSent = isTextSentByMe(combinedText, knownSentTexts) ||
    lines.some((l) => isTextSentByMe(l.text, knownSentTexts));

  let isFromMe = false;
  if (matchesSent) {
    isFromMe = true;
  } else if (minX <= 0.35) {
    // 2. 真实 WeChat 桌面端左侧好友头像对齐：
    // 好友气泡起始坐标牢牢吸附在左侧头像栏 (x <= 0.35)
    // 即使长文本向右延展，其 minX 依然 <= 0.35，绝对不属于我方发出
    isFromMe = false;
  } else if (minX >= 0.60) {
    // 3. 我方右侧绿色气泡对齐：短文本起始直接位于右侧 (minX >= 0.60)
    isFromMe = true;
  } else if (minX >= 0.38 && maxX >= 0.78) {
    // 4. 我方长文本绿色气泡：气泡向左延展，但右边缘必须贴近右侧头像 (maxX >= 0.78)，且起始 minX >= 0.38
    isFromMe = true;
  }

  return {
    text: combinedText,
    lines,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    isFromMe,
  };
}

function isInvalidChatTarget(text: string): boolean {
  if (!text) return true;
  const s = text.trim();
  if (s.length === 0) return true;
  // 过滤 URL 与邮件
  if (/^https?:\/\/|www\.|\.xyz[\/\b]|\.com[\/\b]|\.cn[\/\b]|\.top[\/\b]|\.net[\/\b]|\.org[\/\b]/i.test(s)) return true;
  if (/@(?:gmail|hotmail|qq|163|outlook|foxmail|126)\./i.test(s)) return true;
  // 过滤界面控件符号与搜索/标记
  if (/^[Q\s]*搜索$|^日、|^凶$|^这$|^口$|^8、白$|^⑨$|^［\d+条］/.test(s)) return true;
  if (/微信电脑版|图片浏览|视频播放|文件传输助手|微信支付|订阅号/i.test(s)) return true;
  // 过滤时间戳
  if (/^\d{1,2}[:：\-]\d{2}[|]?$/.test(s)) return true;
  if (/(?:昨天|前天|今天)\s*\d{1,2}[:.：-]\d{2}/.test(s)) return true;
  return false;
}

/** 解析本地 OCR 识别出来的 WeChat 窗口文本序列，提取活跃会话与待回复消息 */
export function parseWeChatOcrItems(
  items: OcrRecognizedItem[],
  knownSentTexts?: Set<string>
): WeChatVisionParseResult {
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
  const explicitTitle = items.find((i) => i.isTitle && i.text.trim().length > 0 && !isInvalidChatTarget(i.text));
  const titleCandidate = explicitTitle || items.find((i) =>
    i.x >= 0.28 && i.x <= 0.80 && i.y >= 0.86 &&
    !isInvalidChatTarget(i.text)
  );
  let chatTarget = titleCandidate ? (normalizeContactName(titleCandidate.text) || titleCandidate.text.trim()) : '';
  if (isInvalidChatTarget(chatTarget)) {
    chatTarget = '';
  }

  // 3. 收集聊天视窗内部的消息气泡候选行
  // 坐标规范：
  // x: [0.27, 0.98] (避开左侧会话栏 x <= 0.26)
  // y: [0.21, 0.86] (避开顶部标题栏 y >= 0.86 与底部表情/输入工具栏 y < 0.21)
  const rawChatItems: OcrRecognizedItem[] = [];

  for (const item of items) {
    if (item.isTitle) continue;
    const text = item.text.trim();
    if (!text) continue;

    // 过滤时间戳行 (如 23:02, 17:42, 22:47, 00:21|, 昨天 15:27)
    if (/^\d{1,2}[:：\-]\d{2}[|]?$/.test(text)) continue;
    if (/(?:昨天|前天|今天|昨灭|靠天|非天|我天)\s*\d{1,2}[:.：-]\d{2}/.test(text)) continue;
    if (/^(?:昨天|前天|今天)$/.test(text)) continue;

    // 过滤单个杂项符号与输入框/工具栏按钮
    if (/^[日、凶这口⑨×…•©·\+\s]+$/.test(text)) continue;
    if (/^[Q\s]*搜索$/.test(text)) continue;
    if (/微信电脑版|图片浏览|视频播放/i.test(text)) continue;

    // 过滤调试标记与统计行（模型、用量、任务ID等）
    if (/^(?:[—\-_]{3,}|🤖|📊|🆔|任务[：:]|[0-9a-f]{8}$|tokens)/i.test(text)) continue;

    // 聊天消息视窗区域 (x: 0.27 - 0.98, y: 0.21 - 0.86)
    if (item.x >= 0.27 && item.x <= 0.98 && item.y <= 0.86 && item.y >= 0.21) {
      rawChatItems.push(item);
    }
  }

  // 执行气泡聚类，合并属于同一消息的多行文字
  const chatBubbles = clusterChatBubbles(rawChatItems, knownSentTexts);

  // 4. 从左侧会话列表 (x: 0.06 - 0.26) 提取未读会话与最新来信
  let listTarget = '';
  let listPreview = '';
  let listUnreadCount = 0;

  const listItems = items.filter((i) => !i.isTitle && i.x >= 0.06 && i.x <= 0.26 && i.y < 0.88 && i.y >= 0.08);
  listItems.sort((a, b) => b.y - a.y);

  let listTargetCoords: [number, number] | undefined;
  for (const li of listItems) {
    const text = li.text.trim();
    if (/^[Q\s]*搜索$/.test(text)) continue;
    if (isInvalidChatTarget(text)) continue;

    const unreadMatch = text.match(/［(\d+)条］/);
    if (unreadMatch) {
      listUnreadCount = parseInt(unreadMatch[1] || '1', 10);
      continue;
    }

    if (!listTarget && !/^\d{1,2}:\d{2}$/.test(text)) {
      const norm = normalizeContactName(text);
      if (norm && !isInvalidChatTarget(norm)) {
        listTarget = norm;
        listTargetCoords = [li.x, li.y];
      }
    } else if (listTarget && !listPreview && !/^\d{1,2}:\d{2}$/.test(text) && text !== listTarget) {
      listPreview = text.replace(/［\d+条］/, '').trim();
      break;
    }
  }

  // 按 Apple Vision 坐标系排序气泡：
  // y 越大代表越靠上 (较早发出的消息)，y 越小代表越靠下 (最新收发的消息)
  chatBubbles.sort((a, b) => b.y - a.y);
  const latestBubble = chatBubbles[chatBubbles.length - 1];

  const target = chatTarget || listTarget || '微信对话';

  if (latestBubble) {
    let isFromMe = latestBubble.isFromMe;
    const cleanText = latestBubble.text;

    if (isTextSentByMe(cleanText, knownSentTexts) || latestBubble.lines.some((l) => isTextSentByMe(l.text, knownSentTexts))) {
      isFromMe = true;
    }

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
    // 但会话列表有明确的【其他联系人】待办新来信
    const normChatTarget = normalizeContactName(target);
    const normListTarget = normalizeContactName(listTarget);
    const isDifferentTarget = normListTarget && normListTarget !== normChatTarget;

    if (isDifferentTarget && listPreview && (listUnreadCount > 0 || !isTextSentByMe(listPreview, knownSentTexts))) {
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
      summary: `当前会话 [${target}] 最新消息由我方发送（“${cleanText}”），无需重复答复`,
      rawResponse: JSON.stringify(items),
    };
  }

  // 视窗内无气泡，仅在会话列表有明确未读且不是当前会话时触发回复
  if (listTarget && listPreview && listUnreadCount > 0 && normalizeContactName(listTarget) !== normalizeContactName(target)) {
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
 * 使用本地原生系统 OCR（macOS Apple Vision / Windows UWP OCR / Linux Tesseract）解析微信界面
 */
export async function parseWeChatScreenViaOcr(
  imageInput: Buffer | string,
  knownSentTexts?: Set<string>
): Promise<WeChatVisionParseResult> {
  // 1. macOS 苹果原生 Vision OCR (零 Token 消耗、~50ms 极速)
  if (process.platform === 'darwin') {
    const ocrBin = ensureMacOcrBinary();
    if (!ocrBin) {
      return {
        ok: false,
        hasWeChatWindow: false,
        needsReply: false,
        error: '本地原生 macOS OCR 引擎未就绪',
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
      return parseWeChatOcrItems(items, knownSentTexts);
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

  // 2. Windows 10/11 原生 WinRT UWP OCR
  if (process.platform === 'win32') {
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

      const escaped = filePath.replace(/\\/g, '\\\\');
      const psOcr = `
        Add-Type -AssemblyName System.Drawing
        [Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null
        [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null
        [Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null

        async function Run-Ocr {
          $file = [Windows.Storage.StorageFile]::GetFileFromPathAsync('${escaped}').GetAwaiter().GetResult()
          $stream = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read).GetAwaiter().GetResult()
          $decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult()
          $softwareBitmap = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult()
          $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
          $result = $engine.RecognizeAsync($softwareBitmap).GetAwaiter().GetResult()
          $items = @()
          $imgW = $softwareBitmap.PixelWidth
          $imgH = $softwareBitmap.PixelHeight
          foreach ($line in $result.Lines) {
            foreach ($word in $line.Words) {
              $r = $word.BoundingRect
              $normX = $r.X / $imgW
              $normW = $r.Width / $imgW
              $normH = $r.Height / $imgH
              $normY = 1.0 - (($r.Y + $r.Height) / $imgH)
              $items += @{
                text = $word.Text
                x = [Math]::Round($normX, 4)
                y = [Math]::Round($normY, 4)
                width = [Math]::Round($normW, 4)
                height = [Math]::Round($normH, 4)
              }
            }
          }
          ConvertTo-Json -InputObject $items -Compress
        }
        Run-Ocr
      `.trim();

      const { stdout } = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psOcr]);
      const items = JSON.parse(stdout.trim() || '[]') as OcrRecognizedItem[];
      if (Array.isArray(items) && items.length > 0) {
        return parseWeChatOcrItems(items, knownSentTexts);
      }
    } catch {
      // 降级使用 VLM
    } finally {
      if (tempPath && existsSync(tempPath)) {
        try { unlinkSync(tempPath); } catch {}
      }
    }
  }

  // 3. Ubuntu / Linux 尝试系统 Tesseract (若已安装)
  if (process.platform === 'linux') {
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

      const { stdout } = await runCmd('tesseract', [filePath, 'stdout', '-l', 'chi_sim+eng', 'tsv']);
      const lines = stdout.split('\n');
      const items: OcrRecognizedItem[] = [];
      let imgW = 1920;
      let imgH = 1080;

      for (let i = 1; i < lines.length; i++) {
        const row = lines[i]?.split('\t');
        if (row && row.length >= 12) {
          const level = row[0];
          const left = parseInt(row[6] || '0', 10);
          const top = parseInt(row[7] || '0', 10);
          const width = parseInt(row[8] || '0', 10);
          const height = parseInt(row[9] || '0', 10);
          const text = (row[11] || '').trim();
          if (level === '1') {
            imgW = width || imgW;
            imgH = height || imgH;
          } else if (text && width > 0 && height > 0) {
            items.push({
              text,
              x: left / imgW,
              y: 1.0 - (top + height) / imgH,
              width: width / imgW,
              height: height / imgH,
            });
          }
        }
      }
      if (items.length > 0) {
        return parseWeChatOcrItems(items, knownSentTexts);
      }
    } catch {
      // 降级使用 VLM
    } finally {
      if (tempPath && existsSync(tempPath)) {
        try { unlinkSync(tempPath); } catch {}
      }
    }
  }

  return {
    ok: false,
    hasWeChatWindow: false,
    needsReply: false,
    error: `本地系统 OCR 引擎在 ${process.platform} 未就绪，将自动降级至云端多模态大模型 VLM`,
  };
}

export interface ImageDiffResult {
  hasDiff: boolean;
  diffRatio: number;
}

/**
 * 屏幕/聊天区域像素基线差异对比 (SightFlow 模式核心)：
 * 借助本地 macOS CoreGraphics 底层显存比对两帧图像。
 * 若无新气泡出现 (diffRatio < 0.005)，则直接跳过耗费资源的 OCR / VLM，杜绝自问自答死循环。
 */
export async function checkImagesDiff(
  img1: Buffer | string,
  img2: Buffer | string
): Promise<ImageDiffResult> {
  const ocrBin = ensureMacOcrBinary();
  if (ocrBin && process.platform === 'darwin') {
    let temp1: string | undefined;
    let temp2: string | undefined;
    try {
      let p1: string;
      if (typeof img1 === 'string' && existsSync(img1)) {
        p1 = img1;
      } else {
        temp1 = join(tmpdir(), `hap_diff1_${Date.now()}_${randomUUID().slice(0, 6)}.png`);
        const b1 = typeof img1 === 'string' ? Buffer.from(img1.replace(/^data:image\/\w+;base64,/, ''), 'base64') : img1;
        writeFileSync(temp1, b1);
        p1 = temp1;
      }

      let p2: string;
      if (typeof img2 === 'string' && existsSync(img2)) {
        p2 = img2;
      } else {
        temp2 = join(tmpdir(), `hap_diff2_${Date.now()}_${randomUUID().slice(0, 6)}.png`);
        const b2 = typeof img2 === 'string' ? Buffer.from(img2.replace(/^data:image\/\w+;base64,/, ''), 'base64') : img2;
        writeFileSync(temp2, b2);
        p2 = temp2;
      }

      const { stdout } = await runCmd(ocrBin, ['--diff', p1, p2]);
      const res = JSON.parse(stdout.trim() || '{}') as { hasDiff?: boolean; diffRatio?: number };
      return {
        hasDiff: Boolean(res.hasDiff),
        diffRatio: Number(res.diffRatio || 0),
      };
    } catch {
      // 降级使用 Buffer 比对
    } finally {
      if (temp1 && existsSync(temp1)) { try { unlinkSync(temp1); } catch {} }
      if (temp2 && existsSync(temp2)) { try { unlinkSync(temp2); } catch {} }
    }
  }

  // 通用/降级快速比对
  try {
    const b1 = typeof img1 === 'string' ? Buffer.from(img1, 'base64') : img1;
    const b2 = typeof img2 === 'string' ? Buffer.from(img2, 'base64') : img2;
    if (b1.equals(b2)) {
      return { hasDiff: false, diffRatio: 0 };
    }
    const len = Math.min(b1.length, b2.length);
    if (Math.abs(b1.length - b2.length) / Math.max(b1.length, b2.length) > 0.05) {
      return { hasDiff: true, diffRatio: 1.0 };
    }
    let diffBytes = 0;
    const sampleStep = 16;
    let sampled = 0;
    for (let i = 0; i < len; i += sampleStep) {
      if (b1[i] !== b2[i]) diffBytes++;
      sampled++;
    }
    const diffRatio = sampled > 0 ? diffBytes / sampled : 0;
    return {
      hasDiff: diffRatio > 0.02,
      diffRatio,
    };
  } catch {
    return { hasDiff: true, diffRatio: 1.0 };
  }
}

