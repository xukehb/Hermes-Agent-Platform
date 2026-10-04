# Docker 多模态模型一键部署设计

## 目标

为模型中心的 9 个外部模型增加 Docker 一键部署能力：自动检查运行条件、构建对应推理镜像、准备模型权重、启动本地服务、执行健康检查，并在成功后自动写入 Hermes 的服务商和模型列表。

## 范围

覆盖以下模型：

- 语音：`openai/whisper-large-v3`、`openai/whisper-base`、`Qwen/Qwen2-Audio-7B-Instruct`、`FunAudioLLM/CosyVoice-300M`
- 图片：`black-forest-labs/FLUX.1-schnell`、`stabilityai/stable-diffusion-3.5-medium`、`stabilityai/sdxl-turbo`
- 视频：`THUDM/CogVideoX-5b`、`tencent/HunyuanVideo`

不把模型权重打进桌面安装包，不在本机直接安装 Conda 或 PyTorch。权重存放在 Docker volume，容器由应用管理。

## 架构

新增 Docker 部署管理模块，使用 Docker CLI 而不是额外 Docker SDK，避免增加 Electron 原生依赖。每个模型由声明式规格描述：模型 ID、镜像、容器名、服务端口、健康检查地址、模型缓存卷、GPU 要求、最小内存和服务协议。

部署流程为：

1. 检查 Docker CLI 和 daemon 是否可用。
2. 检查模型所需 CPU 架构、内存、磁盘和 NVIDIA Container Toolkit 条件。
3. 构建随应用分发的 Dockerfile，创建持久化 volume，并检测实际磁盘与 GPU 显存。
4. 通过容器启动命令下载或挂载指定权重。
5. 流式转发镜像拉取、权重下载和容器日志进度。
6. 轮询健康检查，成功后写入 provider、model、base URL 和能力标签。
7. 失败时保存容器状态与最近日志，并允许重试、停止、删除容器或删除权重。

## 服务接口

每类模型使用匹配的服务协议：

- Whisper、Qwen2-Audio：OpenAI `/v1/audio/transcriptions` 接口。
- CosyVoice：`/v1/audio/speech` 接口，额外要求参考音频与参考文字，不作为语音转写模型。
- 图片模型：OpenAI `/v1/images/generations` 兼容接口。
- 视频模型：项目支持的异步视频生成接口，并在 provider 元数据中标记为 video。

## UI

外部模型卡片的“官方模型主页”旁增加“Docker 一键部署”。部署中显示阶段、日志摘要、端口和预计磁盘占用；成功后显示“本地已就绪”“打开配置”“停止服务”“删除容器”和“删除权重”。不满足条件时禁用按钮并显示具体原因。

## 风险和限制

- 视频模型通常需要 NVIDIA GPU 和大量显存，桌面端无 GPU 时提示改用满足条件的 NVIDIA 主机（当前版本不管理远程 Docker），不尝试下载几十 GB 权重。
- Docker 镜像和模型权重由上游维护，应用只验证镜像拉取、服务启动和健康检查，不宣称模型质量或在线仓库始终可达。
- Docker volume 删除不可恢复，因此 UI 必须区分“删容器”和“删权重”并二次确认。

## 验收标准

- 没有 Docker、daemon 未运行、架构不匹配或 GPU 条件不足时，部署在下载前失败并给出原因。
- 9 个模型均有真实上游 ID 和独立部署规格，不再调用 Ollama `/api/pull`。
- 部署成功后 provider 和 model 出现在模型服务商列表，重启应用后仍保留。
- Docker CLI、规格映射、健康检查、失败清理和模型注册均有自动化测试。
