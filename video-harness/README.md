# Video Harness 产品内核

这是当前视频工作流的项目本地控制层。它把原来一次性、难以回改的生成过程拆成可检查、可审批、可局部返工的阶段，并为后续 OpenDesign 前端提供稳定的数据接口。

所有代码、技能引用、缓存、配置和运行产物都留在 `E:/自媒体/视频制作` 或具体视频项目目录中，不执行全局安装。

## 核心流程

```text
确认文案
   ↓
克隆音色 TTS ──→ 字词时间戳 ──→ 自动字幕
   ↓                         ↓
真实音频时长 ─────────────→ Storyboard
                              ↓
设计规范 + 场景配置 ───────→ 独立场景工程
                              ↓
审阅 / 单场景批注 / 局部返工
                              ↓
场景渲染 → 拼接 → 配音/音乐 → 字幕 → 成片
```

默认有三个审批点：`script`、`storyboard`、`review`。在 `automation` 模式中只保留最终 `review` 审批。

## 当前真实边界

- `runs/video-harness-workflow-demo-20260802` 使用的是**模拟静音 TTS**，只能证明时间轴、字幕、渲染和封装协议可运行，不能证明真实克隆音色已经验收。
- OpenDesign 三页面目前仍是静态原型；Harness 已提供可实际写回项目的本地修改工作台，但尚未替换 OpenDesign 中的硬编码数据。
- 生产校验和生产交付默认拒绝模拟音频，避免测试产物被误认为真实配音成片。
- 工作流支持 HeyGen、ElevenLabs、Kokoro 与本地 IndexTTS2。IndexTTS2 不需要云端凭据，但必须提供项目内本人或已授权参考音频；当前演示仍未包含用户专属参考音频，因此不能冒充已经验收的本人音色。
- 生产音频现在有提供方级预检；缺少凭据、音色、本地依赖或字词对齐能力时，会在调用外部服务前失败，不再仅凭“音频脚本存在”误报可用。

## 项目本地入口

在 `E:/自媒体/视频制作` 下执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./tools/video-harness.ps1 help
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./tools/video-harness.ps1 doctor
```

## 新建项目

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./tools/video-harness.ps1 init `
  "E:/自媒体/01_视频项目/2026/2026-08-02_字幕自动化" `
  --title "字幕自动化" `
  --aspect 9:16 `
  --mode review
```

初始化后，先编辑以下事实来源：

- `script.json`：最终确认文案；每段明确属于哪个场景。
- `voice-profile.json`：TTS 服务商、克隆音色 `voiceId`、语速和发音表。
- `design.json`：颜色、字体、版式、动效和字幕全局样式。
- `storyboard.json`：每个场景的语义、时长补偿、视觉重点、转场和源文件。

## 推荐：可恢复的完整流水线

`advance` 会自动执行确定性的阶段，只在文案、分镜和最终审阅三个质量门暂停。批准后重复运行同一条命令即可续接，不需要人工记忆下一条 CLI。

```powershell
$vh = "./tools/video-harness.ps1"
$project = "<视频项目目录>"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh audio-check $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh advance $project
# 审阅文案后：approve script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh approve script $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh advance $project
# 审阅真实音频驱动的分镜后：approve storyboard
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh approve storyboard $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh advance $project
# 审阅场景与字幕后：approve review
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh approve review $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh advance $project
```

默认场景生成器保留原 `auto-motion` 的创作职责：顺序调用 Claude Code，让它基于完整文案、真实时长和共享 HyperFrames 技能完成每个场景的视觉概念、代码与预渲染。Harness 只增加输入契约、日志、验收和断点续接，不把现有视觉生成逻辑改成固定模板。

如只需要生成或返工一个场景：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh generate $project --scene scene-002
```

无外部调用的工程测试可显式使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh advance $project --mock-audio --mock-render
```

`--mock-audio` 和 `--mock-render` 只用于验证流水线，不代表真实配音或最终视觉质量。

## 在审阅页中修改

生成审阅页后，启动只绑定本机回环地址的工作台：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh review $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh serve $project --port 4173
```

浏览器打开 `http://127.0.0.1:4173/reviews/index.html`。审阅页提供以下入口：

- 全局修改：项目意图与画布、旁白、音色、设计规范、声音混合与交付。
- 场景修改：每个镜头分别修改分镜参数或单镜头画面计划。
- 字幕修改：每条字幕分别修改文字、时间、显隐和局部样式。

工作台不是通用 JSON 编辑器。每个字段都有自己的类型、范围和影响规则；必须先执行“预览影响”，确认需要重算的阶段和撤销的审批后，才能“确认应用”。如果预览后文件被其他窗口修改，原预览会失效并要求重新检查。

工作台顶部同时提供真实流水线控制：

- “推进到下一质量门”异步执行 `advance`，页面轮询任务状态，不在前端复制状态机。
- 只在 `script`、`storyboard`、`review` 到达待审批状态时显示批准按钮；批准不会偷偷修改参数。
- 单镜头环节额外提供“生成或返工当前镜头”和局部意见提交；长任务运行期间拒绝并发写入，避免状态与文件互相覆盖。
- 音色与交付环节显示生产音频预检，分别检查提供方凭据或本地运行时、音色/授权参考音频、IndexTTS2 最小模型、CUDA、字词时间戳/对齐能力和 BGM 依赖。
- 网页请求不能传入任意 runner、音频引擎、mock 开关或文件路径；这些执行配置只由启动服务的一侧注入。

典型影响范围：

- 改旁白文本、演绎或停顿：让音频、分镜时间轴、镜头、字幕和下游交付重新进入质量门；TTS 使用逐段内容缓存，只重新合成变化段，其余段直接复用。
- 改普通分镜视觉参数：只返工被选中的镜头，字幕和其他镜头保持有效。
- 改 `extraHold`：还会改变旁白静音段与后续字幕时间轴，因此同时使音频和字幕过期。
- 改单镜头画面计划：只返工该镜头及审阅、渲染、交付。
- 改单条字幕：只重做字幕、审阅、渲染、交付，不重做音频和镜头。
- 改是否烧录字幕：只重做最终交付。

修改服务不开放局域网监听，只接受同源 JSON 请求，并拒绝读取 `.env`、`.harness` 等非预览文件。每次实际应用只把字段名、前后哈希和影响范围追加到 `.harness/edit-history.jsonl`，不记录音色 ID 的新值或任何密钥。

然后按阶段执行：

```powershell
$vh = "./tools/video-harness.ps1"
$project = "E:/自媒体/01_视频项目/2026/2026-08-02_字幕自动化"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh compile $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh approve script $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh audio $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh plan $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh approve storyboard $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh captions $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh build $project
```

`build` 默认只准备各场景的独立 HyperFrames 工程和 `PROMPT.md`，适合手工或其他外部工具接管。若要调用保留的黑箱生成器，请使用 `generate`。完成场景代码后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh build $project --accept
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh review $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh approve review $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh render $project
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh assemble $project
```

如果只修改了字幕、审阅说明或交付设置，已有场景 MP4 无需重渲染。重新批准审阅后执行 `render --accept` 即可复核并复用现有场景渲染。

## 无凭据模拟验收

模拟模式会生成合法静音 WAV、确定性字词时间戳、场景占位动画和完整 MP4，不调用外部 TTS 或生成模型：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./tools/video-harness.ps1 run `
  "<项目目录>" --mock --auto-approve
```

它用于验证工作流，不代表最终视觉质量。

当前工作区已经提供一份跑通的演示：`runs/video-harness-workflow-demo-20260802`。其三个场景使用真实 HyperFrames 渲染，音频使用模拟静音 TTS；可直接查看 `delivery/final.mp4` 和 `reviews/index.html`。

## 真实克隆音色

云端提供方：

1. 在 `voice-profile.json` 填写真实的 `provider` 和 `voiceId`。
2. 把凭据写入该视频项目的 `.env`，不要写进 JSON、日志或 Git。
3. 先执行 `audio-check`，逐项修复生产预检错误。
4. 执行 `audio`，不要加 `--mock`。

本地 IndexTTS2：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "./video-harness/tools/setup-indextts2.ps1"
```

安装器固定源码、依赖和模型版本，只下载一份约 8.47 GiB 的必要模型集，并跳过约 2.17 GiB 的重复 W2V 检查点；同时准备一个中文 Whisper `small` 模型用于词级对齐。IndexTTS2 只允许 `cuda:0 + FP16` 推理，不训练，也不提供 CPU 推理回退。

然后把参考音频放入视频项目的 `assets/reference/`，并在工作台“音色与演绎”环节选择 IndexTTS2、填写相对路径、确认授权。对应配置示例：

```json
{
  "provider": "indextts2",
  "voiceId": "",
  "cloneRequired": true,
  "referenceAudio": "assets/reference/owner.wav",
  "referenceAudioAuthorized": true,
  "language": "zh-CN",
  "speed": 1,
  "direction": "自然、清晰、克制",
  "settings": {
    "emotionMode": "delivery",
    "emotionWeight": 0.6
  }
}
```

HeyGen 与 ElevenLabs 路由消费服务返回的原生字词时间戳；IndexTTS2 与 Kokoro 必须具备项目本地转录对齐能力。Kokoro 的 `zh-CN` 会规范化为引擎支持的 `zh`；Kokoro 不支持克隆音色。真实模式不会悄悄换成公共默认音色。

当前共享音频引擎在 IndexTTS2 路由实际消费授权参考音频、语速、五种情绪模式、全局 `direction` 与逐段 `delivery`；在 ElevenLabs 路由消费官方音色设置、语速和发音词典。其他提供方尚未支持的高级控制会在预检中明确列出，不能把“字段已填写”当作“演绎已生效”。IndexTTS2 公共版本没有精确时长控制，语速由合成后的 FFmpeg `atempo` 完成，之后再做词级对齐，避免字幕时间戳漂移。

背景音乐的检索/生成可能由共享引擎异步完成。Harness 会等待状态变为 ready、验证文件存在且可探测时长，再允许音频阶段完成；等待超时或 `audio_meta.json.bgm_pending === true` 时，最终装配会被硬性阻止。

## 精细修改，不再整片重做

### 修改某段旁白

编辑 `script.json`，重新执行 `compile`。系统只会让依赖文案的音频、分镜、字幕、场景、审阅和交付过期；独立的设计规范不会被误伤。

### 修改单条字幕

可以直接编辑 `caption-overrides.json`，也可以执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh caption-set $project `
  --id caption-001 `
  --text "这句字幕已经精修。" `
  --start 0.15 `
  --end 1.80 `
  --y -24 `
  --font-size 48

powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh captions $project
```

支持覆盖文字、起止时间、隐藏状态、上下左右偏移、字号、颜色、背景和最大宽度。

### 修改一个场景

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh comment $project `
  --scene scene-002 `
  --text "主标题再大一些，减少右侧装饰。"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh revise $project --scene scene-002
```

系统会生成 `scenes/scene-002/REVISION.md`，只将 `scene-002` 标记为待返工；其他场景和字幕保持有效。完成后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh build $project --scene scene-002 --accept
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vh review $project
```

## 主要产物

- `BRIEF.md`：视频意图与约束。
- `SCRIPT.md`：锁定旁白及交付方式。
- `frame.md`：兼容 HyperFrames 的设计令牌。
- `STORYBOARD.md`：兼容 HyperFrames Studio 的分镜。
- `audio_meta.json`：分段音频、字词时间戳、场景内偏移和完整音轨。
- `captions/`：字幕 JSON、SRT、VTT、支持单条样式覆盖的 ASS。
- `scenes/<id>/`：单场景计划、配置、任务单和独立工程。
- `reviews/index.html`：场景审阅页。
- `edit.html`：按环节修改的本地工作台；应用修改时需通过 `serve` 打开。
- `reviews/revisions.json`：结构化批注历史。
- `.harness/state.json`：阶段与场景状态机。
- `.harness/history.jsonl`：命令执行审计记录。
- `.harness/edit-history.jsonl`：修改字段、前后哈希和失效范围审计记录，不保存字段值。
- `delivery/final.mp4`：最终成片。

## 测试

```powershell
Set-Location "E:/自媒体/视频制作/video-harness"
npm test
```

测试不安装任何依赖，使用 Node 22 内置测试框架；覆盖中文路径、真实音频适配与生产预检、IndexTTS2 CUDA 禁止回退、逐段缓存、BGM 异步等待、模拟 TTS、分环节修改、过期预览拒绝、同源服务保护、异步控制任务、字幕精修、依赖失效、单场景返工、FFmpeg 渲染和最终成片验证。
