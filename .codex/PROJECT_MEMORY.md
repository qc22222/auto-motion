# 项目稳定信息

## 视频生成模型偏好

- 从下一条新的视频生成任务开始，默认使用 `deepseek-v4-flash`。
- 已经开始执行的视频不在中途切换模型，除非用户明确要求。

## 自媒体目录结构

- 视频项目统一存放在 `E:/自媒体/01_视频项目/<年份>/YYYY-MM-DD_视频主题`。
- 公共素材统一存放在 `E:/自媒体/02_公共素材库`。
- 发布状态统一记录在 `E:/自媒体/03_发布管理`。
- 安装包、安装日志和历史项目统一存放在 `E:/自媒体/90_安装包与归档`。
- `视频制作`、`AI_Digital_Human`、`input`、`output`、`tools` 可能存在固定路径依赖，默认保持原位。

## 临时文件清理

- 临时和可恢复文件统一放入 `E:/自媒体/99_临时文件/pending/<批次>`。
- `E:/自媒体/99_临时文件/cleanup-temp.ps1` 只清理超过30天的顶层批次。
- Windows 计划任务名为 `自媒体临时文件清理`，每天03:00运行并在错过后补跑。
- 清理日志位于 `E:/自媒体/99_临时文件/logs`。

## HyperFrames 项目本地技能

- 视频生成模板技能统一位于 `exampleFolder/.claude/skills`，生成新镜头时随模板复制到镜头工作目录。
- 当前包含 19 个 `heygen-com/hyperframes` 官方技能，以及项目保留的 `hyperframes-design`、`hyperframes-motion`、`image-gen` 三个扩展技能。
- 技能只安装在项目目录，不向用户级或全局 `.codex/skills`、`.claude/skills` 写入。
- 被替换的旧版 `hyperframes`、`general-video`、`motion-graphics` 备份在 `.codex/backups/2026-08-02_113837_hyperframes`。

## HyperFrames Windows 兼容注意

- HyperFrames CLI `0.7.88` 的 `init` 在当前 Windows + Node 22 环境可能以原生退出码 `-1073740791` 结束，中文路径和 ASCII 路径均复现。
- 原生 `init` 在中文路径下还可能把 UTF-8 路径误解码为 GBK，并在磁盘根目录创建 `鑷*` 乱码影子目录，因此禁止直接执行 `npx hyperframes init`。
- 项目根目录统一使用 `tools/hyperframes-local.ps1`；镜头模板和生成工程统一使用 `hyperframes-local.ps1`。该入口由 PowerShell 复制项目本地 npm 缓存中的官方 `dist/templates/blank`，不调用原生 `init`。
- npm 缓存固定在 `.codex/npm-cache`，浏览器缓存固定在 `.codex/puppeteer-cache`，运行时缓存固定在 `.codex/hyperframes-cache`；运行时设置 `HYPERFRAMES_SKIP_SKILLS=1`，并阻止 `skills` 命令。
- 中文目标初始化、Git Bash 调用及生成工程 `lint` 已通过；回归入口为 `auto-test/hyperframes-local.test.ps1`。同版本的 `check`、`snapshot` 和 `render` 也已验证可正常工作。

## Video Harness 产品内核

- 产品内核位于 `video-harness/`，统一项目本地入口为 `tools/video-harness.ps1`，不安装全局依赖。
- 视频项目以 `script.json`、`voice-profile.json`、`design.json`、`storyboard.json` 为可编辑事实来源，并生成兼容 HyperFrames 的 BRIEF/SCRIPT/frame/STORYBOARD 文档。
- 支持模拟或真实克隆音色 TTS、字词时间戳、JSON/SRT/VTT/ASS 字幕、单条字幕覆盖、场景级批注和局部返工、真实/模拟渲染与 FFmpeg 交付。
- 演示项目位于 `runs/video-harness-workflow-demo-20260802`；OpenDesign 前端应在用户验收内核后，以现有 JSON/CLI 为接口开始，不把业务逻辑重新塞进界面。

## IndexTTS2 本地 GPU 配音（2026-08-03 交接）

- 模型统一存放在 `E:/models`（纯 ASCII 路径，硬性要求）：
  - `E:/models/indextts2`：27 个固定版本模型文件 + `model-manifest.json`，已按清单逐文件校验。
  - `E:/models/whisper/models/ggml-small.bin`：whisper 对齐模型（465 MiB）。
  - `E:/models/hyperframes-home/.cache/hyperframes/whisper/models/ggml-small.bin`：上述模型的硬链接，供 USERPROFILE 重定向使用，不占额外空间。
- 运行时仍在 `视频制作/.codex/runtime/indextts2`（源码 + Python 3.11 venv + torch 2.8.0+cu128）；`.codex/runtime/whisper/v1.8.6` 为 whisper-cli 可执行文件。
- GPU 冒烟测试已通过：RTX 4060 Laptop、cuda:0 FP16、一句中文约 35-45 秒推理，whisper 转写与输入逐字一致。冒烟产物在 `.codex/runtime/indextts2/.smoke/`。
- 中文路径的四个原生库炸弹及对策（均已落实到代码）：
  1. venv `.pth` GBK 解码失败 → 统一 `python -S` + 显式 `PYTHONPATH`。
  2. kaldifst/wetext 读 site-packages 内 `.fst` 失败 → `indextts2.mjs` 的 `ensureAsciiExecRoot()` 推理前自动 `subst` 建 ASCII 盘符映射（重启后自动重建）。
  3. sentencepiece 读 `bpe.model` 失败，且 CLI 的 `Path.resolve()` 会把 subst 盘符还原为真实路径 → 模型目录固定 `E:/models/indextts2`（`audio-paths.mjs`、`indextts2.mjs`、`setup-indextts2.ps1` 三处默认值已同步）。
  4. whisper-cli 读不了中文用户名下的 `%USERPROFILE%\.cache` 模型 → `tts.mjs` 对齐调用时把子进程 `USERPROFILE` 重定向到 `E:/models/hyperframes-home`。
- 环境变量覆盖点：`INDEXTTS2_ROOT`、`INDEXTTS2_PYTHON`、`INDEXTTS2_MODEL_DIR`、`HYPERFRAMES_WHISPER_PATH`。
- 测试基线：`video-harness` 41 项、音频技能 55 项全部通过；`setup-indextts2.ps1 -VerifyOnly` 端到端校验通过。
- 待用户输入：本人授权参考音频（指南见根目录 `参考音频录制指南.md`），放入视频项目 `assets/reference/` 后执行 `audio-check` → `audio` 完成真实音色验收。
- 工程风险：全部改动仍未提交 git（仓库只有 1 个历史 commit），应尽快分批入库。
