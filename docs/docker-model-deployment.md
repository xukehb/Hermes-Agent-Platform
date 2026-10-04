# Docker 模型部署

模型广场中的语音、图片、视频模型提供 **Docker 一键部署**。这项功能使用桌面应用所在机器的本地 Docker daemon，不连接远程 Docker context。

## 开始使用

1. 安装并启动 Docker Desktop；Linux 安装 Docker Engine。使用 Linux containers。
2. 在 Docker 设置中分配足够内存和磁盘空间。GPU 模型还需 NVIDIA 驱动及 NVIDIA Container Toolkit；Windows 使用 WSL2 GPU 支持。
3. 打开模型广场，在目标模型卡片点击 **Docker 一键部署**。
4. 如仓库要求接受许可，先在 Hugging Face 完成授权，再在部署窗口填入有读取权限的 token。公开仓库可留空。
5. 等待构建环境、下载权重及模型加载。卡片显示当前阶段，**查看日志**提供详细错误。
6. 健康检查通过后，模型自动加入 **模型服务商**。Whisper/Qwen2-Audio 可选作语音转写模型；图片模型可在生图功能中选择。TTS、视频的专用接口可从卡片的 **打开推理接口** 使用。

“停止 / 取消”保留模型卷和配置；再次部署会启动原容器。删除部署移除容器及对应配置，默认保留权重。勾选删除权重会永久删除该模型的缓存卷。已就绪的容器采用 `unless-stopped` 重启策略，退出桌面应用后仍可运行。

首次构建需联网下载系统和 Python 依赖；首次启动还需下载模型。进度展示真实构建/下载日志与阶段，不伪造百分比。受限仓库返回 401/403 时应检查模型许可和 token。提交新 token 会重新创建容器并保留缓存。固定端口被占用时，需要停止占用该端口的程序后重试。

## 模型与运行要求

以下是保守的部署门槛，**不是性能承诺**；实际峰值内存还取决于输入长度和图像尺寸。磁盘门槛是模型下载前的 Docker 剩余空间，不包括此前构建镜像的开销。

| 模型 | 端口 | Docker 内存 GB | 磁盘余量 GB | NVIDIA 单卡显存 GB |
|---|---:|---:|---:|---:|
| Whisper large-v3 | 8201 | 8 | 15 | CPU |
| Whisper base | 8202 | 2 | 10 | CPU |
| Qwen2-Audio 7B | 8203 | 24 | 30 | 16 |
| CosyVoice 300M | 8204 | 8 | 20 | 4 |
| FLUX.1 schnell | 8211 | 32 | 45 | 12 |
| Stable Diffusion 3.5 medium | 8212 | 24 | 30 | 8 |
| SDXL Turbo | 8213 | 16 | 20 | 8 |
| CogVideoX 5B | 8221 | 32 | 40 | 16 |
| HunyuanVideo | 8222 | 64 | 100 | 24 |

CPU Whisper 支持 ARM64/x86_64。此版本的 GPU 部署只支持 x86_64 NVIDIA 主机；macOS Docker 无法使用 Apple GPU，因此只开放 CPU Whisper。硬件不满足要求时按钮会解释原因，不开始下载模型。

HunyuanVideo 的原始来源是 `tencent/HunyuanVideo`，实际使用 Diffusers 文档列出的 `hunyuanvideo-community/HunyuanVideo` 兼容权重。其他八个模型使用卡片所列的官方仓库。CosyVoice 代码固定到 `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`，不安装未使用的 TensorRT/DeepSpeed 加速器。

## 服务接口

所有端口仅发布到 `127.0.0.1`。`/health` 只有在权重加载成功后返回 HTTP 200；加载中或失败返回 503。`/v1/models` 返回该容器的真实模型 ID。`/docs` 展示可调用的接口及参数，调用与该模型不匹配的接口会明确报错。

- **Whisper / Qwen2-Audio**：`POST /v1/audio/transcriptions`，multipart 字段 `model` 和音频 `file`，返回 `{ "text": "..." }`。最多 50 MB、10 分钟音频。
- **CosyVoice 300M**：`POST /v1/audio/speech`，JSON 包含 `model`、`input`、`reference_audio`（base64 音频）、`reference_text`，返回 WAV。此模型用于声音克隆，不支持无参考音频的默认音色，也不能作为语音转写模型。
- **图片**：`POST /v1/images/generations`，JSON 包含 `model`、`prompt`、`size`，返回 OpenAI 格式 `data[0].b64_json` PNG。支持正方形 512、768、1024；每次生成一张。
- **视频**：`POST /v1/videos/generations`，JSON 包含 `model`、`prompt`，返回任务 `id`。使用 `GET /v1/videos/{id}` 查询状态，完成后通过 `/v1/videos/{id}/content` 下载 MP4。采用固定低分辨率 49 帧参数，每个容器同时运行一个任务，内存中最多保留三条任务结果；重启后结果不保留。

示例（Whisper base）：

```sh
curl http://127.0.0.1:8202/v1/audio/transcriptions \
  -F model=openai/whisper-base \
  -F file=@recording.wav
```

## 验证范围

自动化测试验证部署状态转换、错误处理、Docker 命令和健康检查后的配置注册。真实模型推理需要相应硬件、网络和仓库访问权限；不能仅凭容器成功启动或单元测试通过断言九个模型已完成推理验证。
