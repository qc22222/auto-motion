# 完整视频工作流与 IndexTTS2 部署报告

更新时间：2026-08-03

## 1. 结论

本项目已经从“字幕稿直接生成无配音视频”的单向脚本，改造成一条有状态、可审阅、可修改、可局部返工的完整流水线：

```text
创作意图与文案
  → 分段旁白与演绎要求
  → 授权音色合成
  → 字词对齐与字幕
  → 真实音频驱动分镜时长
  → Claude Code + HyperFrames 独立镜头构建
  → 审阅、批注、局部返工
  → 渲染、配音、BGM 侧链、母带、字幕
  → 生产校验与最终交付
```

视觉生产链没有被替换：原有 Claude Code、HyperFrames 和自动动效能力继续负责镜头画面。新增的 Video Harness 负责上游音频、状态机、审批、修改影响分析、缓存和最终交付质量门。

## 2. 第一性原理与架构决策

一条可用的视频生产线至少要解决五个问题：

1. **内容是否正确**：文案必须先锁定，否则后续声音、分镜、字幕都会反复返工。
2. **时间从哪里来**：镜头时长必须来自真实配音，不能先拍脑袋估时再硬塞音频。
3. **中间结果能否修改**：每个参数的影响范围不同，不能把所有修改都简化为“重跑全部”。
4. **失败能否被发现**：有文件不等于成功；还要检查授权、CUDA、时长、静音、字词对齐、响度和最终封装。
5. **昂贵步骤能否复用**：模型只加载一次，旁白按段缓存，镜头按场景返工，字幕和 BGM 独立失效。

因此采用以下分层：

- **创作层**：意图、文案、演绎、分镜、设计规范。
- **生成层**：TTS、字词对齐、镜头构建、渲染。
- **控制层**：状态机、审批、修改预览、精确失效、任务互斥。
- **质检层**：生产预检、音频信号、字幕时间、响度、最终视频探测。
- **交付层**：旁白、BGM、字幕和场景视频装配为最终 MP4。

## 3. 中间修改能力

工作台入口是视频项目中的 `reviews/index.html` 与 `edit.html`。所有修改必须先“预览影响”，再“确认应用”；如果预览后文件被另一个窗口改变，旧预览会被拒绝。

### 3.1 文案与演绎

- 可改：段落名称、旁白文本、逐段 `delivery`、段后停顿、所属场景、锁定状态。
- 影响：音频、真实时长、分镜、镜头、字幕、审阅、渲染、交付。
- 优化：虽然完整下游重新进入质量门，但 TTS 按段缓存，只重新合成文本或演绎发生变化的段落。
- 强制试听：支持只对指定段执行 `--force-tts-line`，无需清空整片缓存。

### 3.2 音色与情绪

- 通用参数：提供方、语言、语速、全局演绎方向。
- IndexTTS2 参数：参考音频相对路径、授权确认、情绪模式、情绪文本、八维向量、情绪参考音频、情绪权重。
- `delivery` 模式：全局 `direction` 作为统一基调，每段 `delivery` 作为局部控制；修改某段只使该段缓存失效。
- 安全：参考音频必须位于视频项目内，绝对路径和目录穿越会被拒绝；未明确确认授权时禁止合成。

### 3.3 分镜与镜头

- 普通分镜视觉参数只使目标镜头及下游过期。
- `extraHold` 会改变时间轴，因此同时影响音频静音段、字幕和后续交付。
- 单镜头画面计划、批注或返工只重做目标镜头，不误伤其他镜头。

### 3.4 字幕

- 可逐条修改文字、起止时间、显示状态、位置、字号、颜色、背景和最大宽度。
- 只使字幕、审阅、渲染与交付过期，不重新生成音频或镜头。

### 3.5 声音混合与交付

- BGM 模式、检索词与音量独立于 TTS 缓存。
- 旁白目标为约 `-16 LUFS`，最终混音目标约 `-14 LUFS`，真峰值上限 `-1 dBTP`。
- BGM 通过侧链压低，避免盖住人声；响度和真峰值不达标时交付失败。
- 是否烧录字幕只影响最终交付，不重新渲染镜头内容。

## 4. IndexTTS2 本地 GPU 路线

### 4.1 硬件策略

- 目标设备：NVIDIA GeForce RTX 4060 Laptop GPU，8 GiB 显存。
- 工作模式：**只做推理，不训练**。
- 固定参数：`--device cuda:0 --fp16`。
- 禁用：DeepSpeed、CUDA 自定义内核、加速引擎、`torch.compile`，避免 8 GiB 显存和 Windows 编译环境的不确定性。
- 硬保护：每次批量合成前运行 `torch.cuda.is_available()`；失败即终止，不会回退到 CPU。
- 性能策略：一个进程加载一次模型，再串行完成同批缺失段，避免每段重复加载模型或并行占满显存。

### 4.2 固定版本

- IndexTTS2 源码：`13495845e3028f0bb6ca1462ad22aa0e76349e40`。
- Python：3.11 项目虚拟环境。
- PyTorch：跟随官方锁文件的 CUDA 12.8 构建。
- 主模型：`IndexTeam/IndexTTS-2@740dcaff396282ffb241903d150ac011cd4b1ede`。
- 辅助模型：W2V-BERT、MaskGCT semantic codec、CAMPPlus、BigVGAN 均固定到清单中的提交版本。

### 4.3 最小下载原则

模型下载器采用“固定提交 + 文件白名单 + 精确大小校验 + 断点续传”，不会执行整仓盲目快照：

- IndexTTS2 主模型约 5.49 GiB。
- 必需辅助模型约 2.98 GiB。
- 合计 27 个文件，约 8.47 GiB。
- 明确跳过 `facebook/w2v-bert-2.0/conformer_shaw.pt`；它与所需 `model.safetensors` 是两套大权重，省约 2.17 GiB。
- 不安装 WebUI、DeepSpeed、FlashAttention、Triton 或测试依赖。

### 4.4 语速与时间戳

IndexTTS2 公开版本没有开放精确时长控制。当前实现先以原速合成，再使用 FFmpeg `atempo` 在 `0.5–2.0` 范围调速，最后重新执行词级对齐，因此字幕时间戳与最终实际音频一致。

## 5. 字词对齐

IndexTTS2 本身不返回工作流所需的词级时间戳。为保证自动字幕可编辑且时间准确，增加固定版本 whisper.cpp：

- 运行时：`whisper.cpp v1.8.6` Windows x64 预编译版。
- 模型：中文可用的 `ggml-small.bin`，单文件约 465 MiB。
- 用途：仅对已经生成的旁白做词级对齐，不训练模型。
- HyperFrames 仍通过项目安全入口执行 `transcribe`；工作流自动指向项目固定的 `whisper-cli.exe`。

## 6. 目录布局

```text
E:/自媒体/视频制作/
  .codex/
    runtime/
      indextts2/                 # 官方固定源码 + 项目 .venv + 单份 uv 缓存
      whisper/v1.8.6/            # whisper-cli.exe 与必要 DLL
    models/
      indextts2/                 # （已迁出）模型现位于 E:/models/indextts2
  E:/models/
    indextts2/                   # 27 个固定版本模型文件 + model-manifest.json（纯 ASCII 路径）
    hyperframes-home/            # whisper 对齐模型的 ASCII 家目录（重定向 USERPROFILE 用）
  video-harness/
    tools/
      setup-indextts2.ps1
      download-indextts2-model.py
      setup-whisper-alignment.py
  <某个视频项目>/
    assets/reference/            # 用户本人或已授权参考音频；默认被 .gitignore 忽略
    assets/voice/                # 分段最终 WAV
    .harness/audio-cache/tts/    # 内容寻址的分段 TTS 缓存
    .harness/audio-temp/         # 批量推理与装配中间文件
```

HyperFrames 当前版本把 Whisper 模型固定读取到 `homedir()/.cache/hyperframes/whisper/models/ggml-small.bin`。本机用户名含中文，whisper-cli 无法打开该路径，因此工作流在调用对齐时把 `USERPROFILE` 重定向到 `E:/models/hyperframes-home`，模型实际保存在该 ASCII 家目录下，仅一份。

补充：sentencepiece、kaldifst（wetext）、whisper-cli 均使用 ANSI 文件 API，无法打开含中文的路径。因此模型目录固定在 `E:/models`；IndexTTS2 运行时仍在中文路径下，推理前会自动用 `subst` 建立 ASCII 盘符映射后再执行。

## 7. 安装与使用

### 7.1 一次性准备

```powershell
Set-Location "E:/自媒体/视频制作"
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "./video-harness/tools/setup-indextts2.ps1"
```

脚本可重复运行：完整文件会跳过，未完成的 `.part` 文件会断点续传。安装后可只校验：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "./video-harness/tools/setup-indextts2.ps1" -VerifyOnly
```

### 7.2 每个视频项目

1. 把清晰、单人、低噪声且有合法授权的参考音频放入 `assets/reference/`。
2. 打开工作台“音色与演绎”，选择 `IndexTTS2（本地 GPU）`。
3. 填写参考音频相对路径并勾选授权确认。
4. 推荐选择“逐段演绎要求”模式，然后在旁白页逐段修改 `delivery`。
5. 执行 `audio-check`；全部通过后执行真实 `audio`。
6. 试听单段或整段，必要时只重生成目标段。
7. 确认真实音频时长后继续分镜、镜头生成、审阅和最终交付。

## 8. 质量门与失败策略

生产音频必须同时满足：

- 参考音频存在且已明确授权。
- IndexTTS2 源码、虚拟环境和 27 个模型文件完整。
- CUDA 可用；禁止 CPU 回退。
- 分段输出存在、时长大于零、不是静音。
- 每段都有非空词级时间戳。
- 旁白装配后的总时长与 Storyboard 一致。

最终交付还必须满足：场景渲染完成、审批完成、BGM 不再 pending、字幕有效、音频响度和真峰值达标、FFprobe 能读取最终 MP4。

## 9. 当前验证状态与边界

- 已完成：参数契约、编辑器字段、授权校验、精确失效、逐段缓存、批量推理适配、CUDA 禁止回退、语速后处理、词级对齐接线、声音母带与交付质量门。
- 正在完成：固定版本依赖与模型文件的实际落盘校验、真实短句 GPU 冒烟测试、全量回归测试。
- 仍需用户输入：用户专属参考音频及明确授权。没有这项输入，不能声称“本人音色质量已验收”。
- 视觉浏览器验收：代码与自动测试可以完成；最终工作台点击和响应式视觉走查仍需可用的应用内浏览器通道。

## 10. 官方资料

- IndexTTS2 官方仓库与安装说明：<https://github.com/index-tts/index-tts>
- IndexTTS2 官方模型：<https://huggingface.co/IndexTeam/IndexTTS-2>
- IndexTTS2 模型许可证：<https://huggingface.co/IndexTeam/IndexTTS-2/blob/main/LICENSE.txt>
- whisper.cpp 官方发布：<https://github.com/ggml-org/whisper.cpp/releases>
- whisper.cpp 官方模型：<https://huggingface.co/ggerganov/whisper.cpp>
- FFmpeg 音频滤镜：<https://ffmpeg.org/ffmpeg-filters.html>
