import type { HostSystemInfo } from './host-info.js';
import { OPEN_SOURCE_MODEL_CATALOG, type CatalogModel, type ModelCategory } from './model-catalog.js';

export type RecommendationTier = 'best' | 'compatible' | 'slow' | 'insufficient';

export interface ModelRecommendationEvaluation {
  model: CatalogModel;
  tier: RecommendationTier;
  tierLabel: string;
  tierColor: string;
  score: number;
  canFitVram: boolean;
  vramOffloadRatio: number; // 0.0 ~ 1.0
  diskSufficient: boolean;
  expectedTokPerSec: string;
  rationale: string;
  warning?: string | undefined;
  isInstalled?: boolean | undefined;
}

export interface HardwareRecommendationProfile {
  machineType: 'nvidia-gpu' | 'apple-silicon' | 'amd-gpu' | 'intel-gpu' | 'cpu-only';
  profileTitle: string;
  profileAdvice: string;
  totalRamGb: number;
  freeRamGb: number;
  gpuName?: string | undefined;
  vramTotalGb?: number | undefined;
  freeDiskGb: number;
  evaluations: ModelRecommendationEvaluation[];
}

const GB = 1024 * 1024 * 1024;

/**
 * 根据机器硬件配置评估单个大语言模型的匹配度
 */
export function evaluateModelForHardware(
  model: CatalogModel,
  sysInfo: HostSystemInfo,
  installedModelIds: Set<string> = new Set()
): ModelRecommendationEvaluation {
  const totalRam = sysInfo.memory?.totalBytes || 8 * GB;
  const freeRam = sysInfo.memory?.freeBytes || 4 * GB;
  const freeDisk = sysInfo.disk?.freeBytes || 50 * GB;

  // 提取显卡显存
  const primaryGpu = (sysInfo.gpus && sysInfo.gpus.length > 0) ? sysInfo.gpus[0] : undefined;
  const isAppleSilicon = sysInfo.os?.platform === 'darwin' && (primaryGpu?.vendor === 'apple' || sysInfo.cpu?.model?.includes('Apple'));
  const hasDedicatedGpu = Boolean(primaryGpu && (primaryGpu.vendor === 'nvidia' || primaryGpu.vendor === 'amd' || primaryGpu.memoryTotalBytes >= 2 * GB));

  const totalVram = isAppleSilicon
    ? Math.round(totalRam * 0.75) // Apple 统一内存最多允许 ~75% 划归 Metal 显存
    : (primaryGpu?.memoryTotalBytes || 0);

  const diskNeeded = Math.round(model.downloadSizeBytes * 1.25);
  const diskSufficient = freeDisk >= diskNeeded;

  let tier: RecommendationTier = 'compatible';
  let tierLabel = '⚡ 流畅运行';
  let tierColor = '#10b981'; // green
  let score = 50;
  let canFitVram = false;
  let vramOffloadRatio = 0;
  let expectedTokPerSec = '15 ~ 25 tok/s';
  let rationale = '';
  let warning: string | undefined;

  // 1. 显存装载计算
  if (totalVram > 0) {
    vramOffloadRatio = Math.min(1.0, totalVram / (model.recommendedVramBytes || 1));
    canFitVram = totalVram >= model.recommendedVramBytes;
  }

  // 2. 硬件判定层级
  if (totalRam < model.minRamBytes) {
    // 内存严重不足
    tier = 'insufficient';
    tierLabel = '❌ 硬件不足';
    tierColor = '#ef4444'; // red
    score = 10;
    expectedTokPerSec = '无法流畅加载';
    rationale = `该模型至少需要 ${(model.minRamBytes / GB).toFixed(1)} GB 内存，您的电脑总物理内存为 ${(totalRam / GB).toFixed(1)} GB，直接运行极易引发系统严重卡死或崩溃。`;
    warning = '不建议在此设备上运行，建议选择更轻量的 1.5B/3B/7B 模型。';
  } else if (canFitVram) {
    // 显存/统一内存完全吃下
    tier = 'best';
    tierLabel = '🌟 最佳匹配';
    tierColor = '#f59e0b'; // amber / gold
    score = 95 - model.paramNumBillion * 0.5; // 轻快且完全加速的排最前
    expectedTokPerSec = model.paramNumBillion <= 3 ? '60 ~ 100+ tok/s' : (model.paramNumBillion <= 8 ? '35 ~ 60 tok/s' : '25 ~ 40 tok/s');
    
    if (isAppleSilicon) {
      rationale = `Mac 统一内存（约 ${(totalVram / GB).toFixed(1)} GB 可用）可 100% 装载全部网络层，Metal 硬件加速极速响应！`;
    } else {
      rationale = `独显显存（${(totalVram / GB).toFixed(1)} GB）可完全装下该模型所有权重与 KV Cache，GPU 纯算力推理极速丝滑！`;
    }
  } else if (vramOffloadRatio >= 0.5) {
    // 显卡可卸载一半以上层数，剩余层 CPU + 内存混合推理
    tier = 'compatible';
    tierLabel = '⚡ 流畅运行';
    tierColor = '#10b981';
    score = 80 - model.paramNumBillion * 0.4;
    expectedTokPerSec = model.paramNumBillion <= 8 ? '20 ~ 35 tok/s' : '12 ~ 20 tok/s';
    rationale = `显卡可分担 ${Math.round(vramOffloadRatio * 100)}% 权重层计算，结合系统内存（${(totalRam / GB).toFixed(0)} GB）流畅混合推理，速度满足日常阅读。`;
  } else if (!hasDedicatedGpu && totalRam >= model.recommendedRamBytes) {
    // 纯 CPU 机器，但内存充足
    if (model.paramNumBillion <= 3) {
      tier = 'best';
      tierLabel = '🌟 极速适配 (CPU)';
      tierColor = '#3b82f6';
      score = 90;
      expectedTokPerSec = '25 ~ 45 tok/s';
      rationale = '超轻量模型无需独显，依靠纯 CPU 多核指令集即可极速并发生成！';
    } else if (model.paramNumBillion <= 8) {
      tier = 'compatible';
      tierLabel = '⚡ CPU 可流畅运行';
      tierColor = '#10b981';
      score = 70;
      expectedTokPerSec = '10 ~ 18 tok/s';
      rationale = '纯 CPU 推理可稳定运行，生成速率适合日常阅读与代码编写。';
    } else {
      tier = 'slow';
      tierLabel = '⚠️ CPU 推理较慢';
      tierColor = '#eab308';
      score = 40;
      expectedTokPerSec = '3 ~ 6 tok/s';
      rationale = '大参数模型无独显加速时 CPU 负担较重，生成速度偏慢（字逐个析出）。';
    }
  } else {
    // 内存偏紧张或参数偏大
    tier = 'slow';
    tierLabel = '⚠️ 勉强运行';
    tierColor = '#f97316';
    score = 30;
    expectedTokPerSec = '2 ~ 5 tok/s';
    rationale = `该模型运行需占用大量内存（建议 ${(model.recommendedRamBytes / GB).toFixed(0)} GB），可能引起轻微卡顿与发热。`;
    warning = '可用系统资源接近临界值，建议优先选择轻量规格。';
  }

  if (!diskSufficient) {
    warning = (warning ? warning + '；' : '') + `磁盘剩余空间不足（剩余 ${(freeDisk / GB).toFixed(1)} GB，需要至少 ${(diskNeeded / GB).toFixed(1)} GB）`;
    score -= 20;
  }

  const isInstalled = installedModelIds.has(model.id) || installedModelIds.has(`ollama/${model.id}`);

  return {
    model,
    tier,
    tierLabel,
    tierColor,
    score,
    canFitVram,
    vramOffloadRatio,
    diskSufficient,
    expectedTokPerSec,
    rationale,
    warning,
    isInstalled,
  };
}

/**
 * 对所有生态目录模型进行智能评级、推荐与排序
 */
export function getHardwareRecommendationProfile(
  sysInfo: HostSystemInfo,
  installedModelIds: Set<string> = new Set(),
  categoryFilter?: ModelCategory | 'all'
): HardwareRecommendationProfile {
  const totalRamGb = Math.round(((sysInfo.memory?.totalBytes || 0) / GB) * 10) / 10;
  const freeRamGb = Math.round(((sysInfo.memory?.freeBytes || 0) / GB) * 10) / 10;
  const freeDiskGb = Math.round(((sysInfo.disk?.freeBytes || 0) / GB) * 10) / 10;

  const primaryGpu = (sysInfo.gpus && sysInfo.gpus.length > 0) ? sysInfo.gpus[0] : undefined;
  const isApple = sysInfo.os?.platform === 'darwin' && (primaryGpu?.vendor === 'apple' || sysInfo.cpu?.model?.includes('Apple'));
  const isNvidia = primaryGpu?.vendor === 'nvidia';
  const isAmd = primaryGpu?.vendor === 'amd';
  const isIntelGpu = primaryGpu?.vendor === 'intel';

  let machineType: HardwareRecommendationProfile['machineType'] = 'cpu-only';
  let profileTitle = '常规 CPU 办公本 / 台式电脑';
  let profileAdvice = '适合优先运行 1.5B ~ 3B 极速端侧模型或 7B 轻量量化模型，内存占用低且响应迅速。';

  let vramTotalGb: number | undefined;

  if (isApple) {
    machineType = 'apple-silicon';
    vramTotalGb = Math.round((totalRamGb * 0.75) * 10) / 10;
    profileTitle = `Apple Silicon Mac (${sysInfo.cpu?.model || 'M系列芯片'})`;
    if (totalRamGb >= 32) {
      profileAdvice = `拥有超大 ${totalRamGb}GB 统一内存，高显存带宽优势显著！推荐 14B 与 32B 深度思考大模型，可获得绝佳推理体验。`;
    } else {
      profileAdvice = `配备 ${totalRamGb}GB 统一内存，推荐首选 7B/8B 黄金规格模型（如 Qwen2.5-Coder 7B / DeepSeek-R1 8B），速度飞快！`;
    }
  } else if (isNvidia && primaryGpu) {
    machineType = 'nvidia-gpu';
    vramTotalGb = Math.round(((primaryGpu.memoryTotalBytes || 0) / GB) * 10) / 10;
    profileTitle = `NVIDIA 独显主机 (${primaryGpu.name} · ${vramTotalGb}GB 显存)`;
    if (vramTotalGb >= 16) {
      profileAdvice = `具备强悍的 ${vramTotalGb}GB 显存与 ${totalRamGb}GB 内存，可完整运行 14B~32B 顶尖开源大模型，深度思考与编程体验拉满！`;
    } else if (vramTotalGb >= 6) {
      profileAdvice = `配备优秀的 ${vramTotalGb}GB 显存与 ${totalRamGb}GB 内存，7B/8B 黄金段模型可完全载入显存秒速生成，推荐 7B 级代码与推理模型！`;
    } else {
      profileAdvice = `配备 ${vramTotalGb}GB 显存，推荐 1.5B ~ 3B 极速端侧模型或 7B Q4 量化模型混合加速。`;
    }
  } else if (isAmd && primaryGpu) {
    machineType = 'amd-gpu';
    vramTotalGb = Math.round(((primaryGpu.memoryTotalBytes || 0) / GB) * 10) / 10;
    profileTitle = `AMD Radeon 主机 (${primaryGpu.name})`;
    profileAdvice = `配备 AMD 显卡与 ${totalRamGb}GB 内存，推荐 3B ~ 7B 规格模型。`;
  } else if (isIntelGpu && primaryGpu) {
    machineType = 'intel-gpu';
    profileTitle = `Intel 核显 / 锐炫显卡电脑 (${primaryGpu.name})`;
    profileAdvice = `推荐 1.5B ~ 3B 轻量代码与对话模型，可在极低功耗下毫秒级响应。`;
  }

  // 过滤并打分排序
  let models = OPEN_SOURCE_MODEL_CATALOG;
  if (categoryFilter && categoryFilter !== 'all') {
    models = models.filter((m) => m.category === categoryFilter);
  }

  const evaluations = models.map((m) => evaluateModelForHardware(m, sysInfo, installedModelIds));

  // 排序规则：
  // 1. 优先已安装模型？不，推荐度得分高（🌟最佳匹配 -> ⚡流畅 -> ⚠️偏慢 -> ❌不足）排在前面
  // 2. 相同 tier 下得分高的排前
  const tierWeight: Record<RecommendationTier, number> = {
    best: 400,
    compatible: 300,
    slow: 200,
    insufficient: 100,
  };

  evaluations.sort((a, b) => {
    const weightDiff = tierWeight[b.tier] - tierWeight[a.tier];
    if (weightDiff !== 0) return weightDiff;
    return b.score - a.score;
  });

  return {
    machineType,
    profileTitle,
    profileAdvice,
    totalRamGb,
    freeRamGb,
    gpuName: primaryGpu?.name,
    vramTotalGb,
    freeDiskGb,
    evaluations,
  };
}
