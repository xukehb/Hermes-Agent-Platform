/**
 * 开源大语言模型生态目录与元数据
 * 包含模型标识、参数量、量化文件大小、最低/推荐内存与显存要求、应用场景与特性标签
 */

export type ModelCategory = 'coding' | 'reasoning' | 'general' | 'fast';

export interface CatalogModel {
  /** Ollama 官方模型拉取标识，如 'qwen2.5-coder:7b' */
  id: string;
  /** 展示名称 */
  name: string;
  /** 完整业务别名展示 */
  displayName: string;
  /** 模型所属家族 / 出品团队 */
  family: 'DeepSeek' | 'Qwen' | 'Meta' | 'Google' | 'Microsoft' | 'Mistral';
  /** 主打应用场景类别 */
  category: ModelCategory;
  /** 参数量字符表示 (如 '7B') */
  paramSize: string;
  /** 数值化参数量 (十亿参数量，如 7) */
  paramNumBillion: number;
  /** 默认分发量化精度 (主流为 Q4_K_M) */
  quantization: string;
  /** 预估下载权重文件大小 (字节) */
  downloadSizeBytes: number;
  /** 最低物理内存要求 (字节) */
  minRamBytes: number;
  /** 推荐物理内存 (字节) */
  recommendedRamBytes: number;
  /** GPU 最低可用显存要求 (字节，若配备独显) */
  minVramBytes: number;
  /** 推荐独显显存 (完全装载所有网络层与 KV Cache 所需字节) */
  recommendedVramBytes: number;
  /** 支持的最大上下文窗口 */
  contextLength: string;
  /** 详细中文介绍 */
  description: string;
  /** 核心能力亮点 */
  strengths: string[];
  /** 标签组 */
  tags: string[];
  /** 醒目标签 (如 '热门首选', '强烈推荐', '极速轻巧') */
  badge?: string;
  /** 推荐默认运行协议 */
  protocol: 'openai-tools' | 'hermes-native';
}

const GB = 1024 * 1024 * 1024;

export const OPEN_SOURCE_MODEL_CATALOG: CatalogModel[] = [
  // -------------------------------------------------------------
  // 1. 轻量端侧 / 极速日常 / 各种电脑均可运行 (1.5B ~ 3B)
  // -------------------------------------------------------------
  {
    id: 'qwen2.5-coder:1.5b',
    name: 'Qwen 2.5 Coder (1.5B)',
    displayName: 'Qwen 2.5 Coder 1.5B (轻量编程小钢炮)',
    family: 'Qwen',
    category: 'fast',
    paramSize: '1.5B',
    paramNumBillion: 1.5,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(1.0 * GB),
    minRamBytes: 4 * GB,
    recommendedRamBytes: 8 * GB,
    minVramBytes: Math.round(1.5 * GB),
    recommendedVramBytes: Math.round(2.0 * GB),
    contextLength: '32K',
    description: '阿里云专为轻量环境打造的代码模型，几乎可在任何核显轻薄本或老旧电脑上以 60+ tok/s 极速狂飙，精通轻量代码补全与语法问答。',
    strengths: ['极低资源消耗', '纯 CPU 毫秒级生成', '语法补全与纠错'],
    tags: ['代码编程', '极速', '轻薄本友好', '阿里通义'],
    badge: '极速轻巧',
    protocol: 'openai-tools',
  },
  {
    id: 'llama3.2:3b',
    name: 'Llama 3.2 (3B)',
    displayName: 'Llama 3.2 3B (Meta 极速端侧主力)',
    family: 'Meta',
    category: 'fast',
    paramSize: '3B',
    paramNumBillion: 3,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(2.0 * GB),
    minRamBytes: 6 * GB,
    recommendedRamBytes: 8 * GB,
    minVramBytes: Math.round(2.5 * GB),
    recommendedVramBytes: Math.round(3.5 * GB),
    contextLength: '128K',
    description: 'Meta 针对边缘和端侧优化的轻量大模型，原生支持 128K 长上下文，具备卓越的日常对话、文字摘要与信息归纳能力。',
    strengths: ['128K 超长上下文', '日常对话流畅', '低内存占用'],
    tags: ['端侧通用', 'Meta', '长上下文', '轻量'],
    badge: '端侧明星',
    protocol: 'openai-tools',
  },
  {
    id: 'deepseek-r1:1.5b',
    name: 'DeepSeek-R1 (1.5B)',
    displayName: 'DeepSeek-R1 1.5B (端侧思考推理)',
    family: 'DeepSeek',
    category: 'reasoning',
    paramSize: '1.5B',
    paramNumBillion: 1.5,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(1.1 * GB),
    minRamBytes: 4 * GB,
    recommendedRamBytes: 8 * GB,
    minVramBytes: Math.round(1.5 * GB),
    recommendedVramBytes: Math.round(2.0 * GB),
    contextLength: '32K',
    description: '基于 Qwen 2.5 蒸馏的轻量深度思考模型，在极低参数规模下依然保留了 <think> 链式推理能力，适合体验深度思考架构。',
    strengths: ['保留思维链 (Chain of Thought)', '数理逻辑起步', '低算力门槛'],
    tags: ['深度思考', 'DeepSeek', '推理小钢炮'],
    protocol: 'openai-tools',
  },

  // -------------------------------------------------------------
  // 2. 主流黄金规格 / 绝大多数独显与 16G 内存的最佳主力 (7B ~ 8B)
  // -------------------------------------------------------------
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder (7B)',
    displayName: 'Qwen 2.5 Coder 7B (全能代码专家)',
    family: 'Qwen',
    category: 'coding',
    paramSize: '7B',
    paramNumBillion: 7,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(4.7 * GB),
    minRamBytes: 8 * GB,
    recommendedRamBytes: 16 * GB,
    minVramBytes: Math.round(4.5 * GB),
    recommendedVramBytes: Math.round(6.0 * GB),
    contextLength: '128K',
    description: '全球公认顶级的开源代码大模型之一，全栈精通 90+ 编程语言，支持多文件项目架构推导、精准函数实现与自动化测试生成。',
    strengths: ['90+ 编程语言', '代码补全/生成/重构', '128K 上下文', '与智能体完美配合'],
    tags: ['代码神器', '智能体首选', '阿里通义', '7B 黄金段'],
    badge: '开发者首选',
    protocol: 'openai-tools',
  },
  {
    id: 'deepseek-r1:8b',
    name: 'DeepSeek-R1 (8B)',
    displayName: 'DeepSeek-R1 8B (Llama 蒸馏深度推理)',
    family: 'DeepSeek',
    category: 'reasoning',
    paramSize: '8B',
    paramNumBillion: 8,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(4.9 * GB),
    minRamBytes: 10 * GB,
    recommendedRamBytes: 16 * GB,
    minVramBytes: Math.round(5.0 * GB),
    recommendedVramBytes: Math.round(6.5 * GB),
    contextLength: '32K',
    description: 'DeepSeek 官方通过 Llama-3.1-8B 蒸馏的高人气模型，具备完整的复杂数学、逻辑证明、算法推导深度思维链（Chain of Thought）。',
    strengths: ['完整思辨推理链', '数学解题与算法推演', '逻辑分析极其敏锐'],
    tags: ['深度思考', 'DeepSeek', '爆款模型', '复杂逻辑'],
    badge: '火爆热搜',
    protocol: 'openai-tools',
  },
  {
    id: 'deepseek-r1:7b',
    name: 'DeepSeek-R1 (7B)',
    displayName: 'DeepSeek-R1 7B (Qwen 蒸馏中文推理)',
    family: 'DeepSeek',
    category: 'reasoning',
    paramSize: '7B',
    paramNumBillion: 7,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(4.7 * GB),
    minRamBytes: 8 * GB,
    recommendedRamBytes: 16 * GB,
    minVramBytes: Math.round(4.5 * GB),
    recommendedVramBytes: Math.round(6.0 * GB),
    contextLength: '32K',
    description: 'DeepSeek 官方通过 Qwen-2.5-7B 蒸馏的深度推理模型，中文理解与中文逻辑推导表现卓越，中文技术问答首选。',
    strengths: ['原生中文逻辑思维', '中文数理推导', '兼顾代码逻辑'],
    tags: ['深度思考', '中文旗舰', '通义底座', 'DeepSeek'],
    badge: '中文推荐',
    protocol: 'openai-tools',
  },
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 (8B)',
    displayName: 'Llama 3.1 8B (Meta 综合旗舰基座)',
    family: 'Meta',
    category: 'general',
    paramSize: '8B',
    paramNumBillion: 8,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(4.7 * GB),
    minRamBytes: 8 * GB,
    recommendedRamBytes: 16 * GB,
    minVramBytes: Math.round(4.5 * GB),
    recommendedVramBytes: Math.round(6.0 * GB),
    contextLength: '128K',
    description: 'Meta 开源基座的行业标杆，在英文、多语言、工具调用、结构化 JSON 输出和日常角色扮演方面拥有极高的一致性与稳定性。',
    strengths: ['128K 长文本', '结构化输出精准', '多语言通用能力强'],
    tags: ['通用基座', 'Meta', '工具调用', '高稳定性'],
    protocol: 'openai-tools',
  },
  {
    id: 'gemma2:9b',
    name: 'Gemma 2 (9B)',
    displayName: 'Gemma 2 9B (Google 高精炼模型)',
    family: 'Google',
    category: 'general',
    paramSize: '9B',
    paramNumBillion: 9,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(5.5 * GB),
    minRamBytes: 12 * GB,
    recommendedRamBytes: 16 * GB,
    minVramBytes: Math.round(6.0 * GB),
    recommendedVramBytes: Math.round(7.5 * GB),
    contextLength: '8K',
    description: 'Google 深度研发的高参数质量大模型，在 MMLU 和 GSM8k 等多个关键基准上越级击败众多更大体量的模型。',
    strengths: ['越级综合学术表现', '事实问答准确度高', 'Google 严谨精炼'],
    tags: ['Google', '学术高分', '高精炼'],
    protocol: 'openai-tools',
  },

  // -------------------------------------------------------------
  // 3. 进阶中大规格 / 适合 8G~16G 独显、32G 内存或 Mac M 系列 (14B ~ 32B)
  // -------------------------------------------------------------
  {
    id: 'qwen2.5-coder:14b',
    name: 'Qwen 2.5 Coder (14B)',
    displayName: 'Qwen 2.5 Coder 14B (进阶架构级代码模型)',
    family: 'Qwen',
    category: 'coding',
    paramSize: '14B',
    paramNumBillion: 14,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(9.0 * GB),
    minRamBytes: 16 * GB,
    recommendedRamBytes: 32 * GB,
    minVramBytes: Math.round(8.5 * GB),
    recommendedVramBytes: Math.round(11.0 * GB),
    contextLength: '128K',
    description: '不仅能写代码，更能设计架构与重构大型模块。在更长代码库扫描与排查诡异 Bug 时展现出远超 7B 的宏观视野。',
    strengths: ['大型工程架构理解', '多文件上下文联动', '媲美 GPT-4o-mini 代码水准'],
    tags: ['代码专家', '进阶生产力', '阿里通义', '14B 旗舰'],
    badge: '强力生产力',
    protocol: 'openai-tools',
  },
  {
    id: 'deepseek-r1:14b',
    name: 'DeepSeek-R1 (14B)',
    displayName: 'DeepSeek-R1 14B (进阶数学与算法推理)',
    family: 'DeepSeek',
    category: 'reasoning',
    paramSize: '14B',
    paramNumBillion: 14,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(9.0 * GB),
    minRamBytes: 16 * GB,
    recommendedRamBytes: 32 * GB,
    minVramBytes: Math.round(8.5 * GB),
    recommendedVramBytes: Math.round(11.0 * GB),
    contextLength: '32K',
    description: '兼顾深度思考的深刻性与日常推理的运行效率，复杂数学竞赛、算法优化与多步分析的强悍利器。',
    strengths: ['竞赛级数理推导', '多步长链逻辑闭环', '深度代码逻辑分析'],
    tags: ['深度思考', 'DeepSeek', '14B 进阶'],
    protocol: 'openai-tools',
  },
  {
    id: 'deepseek-r1:32b',
    name: 'DeepSeek-R1 (32B)',
    displayName: 'DeepSeek-R1 32B (极客级准满血推理)',
    family: 'DeepSeek',
    category: 'reasoning',
    paramSize: '32B',
    paramNumBillion: 32,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(20.0 * GB),
    minRamBytes: 24 * GB,
    recommendedRamBytes: 36 * GB,
    minVramBytes: Math.round(18.0 * GB),
    recommendedVramBytes: Math.round(22.0 * GB),
    contextLength: '32K',
    description: '最具性价比的准满血开源推理之王。思考深度与解答精度逼近甚至在部分理科测试上媲美商业顶尖推理，适合配备 24G 显存或 32G+ 内存的高性能主机。',
    strengths: ['媲美顶尖商业推理模型', '极深思维链探索', '复杂逻辑零幻觉追求'],
    tags: ['准满血推理', 'DeepSeek', '高阶工作站', '32B 巨兽'],
    badge: '顶尖推理',
    protocol: 'openai-tools',
  },
  {
    id: 'qwen2.5:32b',
    name: 'Qwen 2.5 (32B)',
    displayName: 'Qwen 2.5 32B (通用高阶全能王)',
    family: 'Qwen',
    category: 'general',
    paramSize: '32B',
    paramNumBillion: 32,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(20.0 * GB),
    minRamBytes: 24 * GB,
    recommendedRamBytes: 36 * GB,
    minVramBytes: Math.round(18.0 * GB),
    recommendedVramBytes: Math.round(22.0 * GB),
    contextLength: '128K',
    description: '通义千问开源系列中最强力、平衡的通用模型。在文学创作、角色扮演、复杂工具交互和长文解析上达到商业级水平。',
    strengths: ['128K 顶级上下文', '全能百科问答', '极佳指令遵循'],
    tags: ['高阶通用', '阿里通义', '商业级表现'],
    protocol: 'openai-tools',
  },

  // -------------------------------------------------------------
  // 4. 终极旗舰 / 适合企业服务器、双卡 24G 或 Mac Studio 64G+ (70B+)
  // -------------------------------------------------------------
  {
    id: 'deepseek-r1:70b',
    name: 'DeepSeek-R1 (70B)',
    displayName: 'DeepSeek-R1 70B (终极开源推理旗舰)',
    family: 'DeepSeek',
    category: 'reasoning',
    paramSize: '70B',
    paramNumBillion: 70,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(43.0 * GB),
    minRamBytes: 48 * GB,
    recommendedRamBytes: 64 * GB,
    minVramBytes: Math.round(40.0 * GB),
    recommendedVramBytes: Math.round(48.0 * GB),
    contextLength: '32K',
    description: '开源深度思考巅峰之作。基于 Llama-3.3-70B 蒸馏，具备宏大的世界知识底蕴与超强推理证明能力，适合工作站与私有化服务器。',
    strengths: ['开源推理巅峰水准', '极其深邃的思辨论证', '专家级多学科求解'],
    tags: ['终极旗舰', 'DeepSeek', '服务器级别', '70B'],
    badge: '算力怪兽',
    protocol: 'openai-tools',
  },
  {
    id: 'llama3.3:70b',
    name: 'Llama 3.3 (70B)',
    displayName: 'Llama 3.3 70B (Meta 最新顶级开源基座)',
    family: 'Meta',
    category: 'general',
    paramSize: '70B',
    paramNumBillion: 70,
    quantization: 'Q4_K_M',
    downloadSizeBytes: Math.round(43.0 * GB),
    minRamBytes: 48 * GB,
    recommendedRamBytes: 64 * GB,
    minVramBytes: Math.round(40.0 * GB),
    recommendedVramBytes: Math.round(48.0 * GB),
    contextLength: '128K',
    description: 'Meta 全新发布的 70B 旗舰模型，能以 70B 体量提供与之前 405B 相媲美的综合基准表现，指令遵循与多语言表现极为出色。',
    strengths: ['媲美超大体量模型', '128K 完整长上下文', '行业顶尖泛化能力'],
    tags: ['Meta 旗舰', '高阶通用', '服务器级别'],
    protocol: 'openai-tools',
  },
];
