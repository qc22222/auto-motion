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

## Kokoro 本地默认音色链路(2026-08-03 启用)

- kokoro-onnx 0.5.0 装在 `.codex/python-audio`(setup-kokoro.ps1 创建)。
- 用户级环境变量:`HYPERFRAMES_PYTHON`、`HYPERFRAMES_WHISPER_PATH`(setx 已设置)。
- 中文路径炸弹新增一例:espeak-ng 数据目录被 dll 硬编码为构建路径,且 ANSI API 读不了中文路径 → `espeakng_loader/get_data_path()` 已打补丁优先用 `E:/models/espeak-ng-data`(ASCII 副本)。
- 已修 bug:kokoro 输出 24kHz 导致 harness 旁白时长校验失败 → `tts.mjs` kokoro 分支补 44.1kHz 转码;`setup-kokoro.ps1` 修 GetRelativePath(.NET Framework)与中文 print 编码两处。
- 测试基线:音频技能 55 项全绿。commit `f764f62`。

## 克隆音色参数(2026-08-03 用户确认)

- 参考音频:`视频创作自动化流水线实践.mp3`(11.5s)→ 各项目 `assets/reference/owner.wav`(volume 3dB 增益,44.1k mono)。
- voice-profile 关键参数:`provider=indextts2`、`speed=1.1`、`direction=热情、明快、有感染力、元气满满、精神饱满`、`emotionMode=delivery`、`emotionWeight=0.8`。
- 旧参考音频(养老金...mp3)响度过低(-23dB、LRA 1.4)导致克隆低沉,已弃用;源 mp3 在项目根目录未入库,建议移入各项目 `assets/reference/`。
- 待办:新音色(11.47s)与旧场景时长不匹配,正式成片需重新生成场景(Claude Code ~40min)或下次新建项目直接使用。
## 场景生成并行化(2026-08-03 实测通过)

- `pipeline.mjs` 一次调用 `generateScenes`(内部按状态过滤 pending,已 complete 不重跑);`generator.mjs` 用 `mapWithConcurrency` 有界并发,默认 3,`HYPERFRAMES_SCENE_CONCURRENCY` 可配,=1 退化为串行。
- 失败隔离:单场景失败只标记自身,全部结束后统一汇总。
- 竞态修复:并行时场景 A 完成触发的 `compileProject` 会用 inputHash 检测误标其他 running 场景 → `compile.mjs` 已跳过 running 场景。
- 实测:3 场景 22min(串行 50min),成功率与时长校验零折扣;45 项测试全绿。
## P2 OpenDesign 前端接线(2026-08-04 进度)

- console 三页面在 `video-harness/console/`(index/workspace/delivery + console-api.js/console-ui.js/workspace-tabs.js/workspace-wiring.js + assets/workbench.css)。
- 服务层:`server.mjs` 新增 `/console/` 静态路由(安全路径、缺失 404)、只读端点 `GET /api/project`(项目详情 + manifest.files)、`STATIC_PREFIXES` 含 `delivery/`。
- 使用:`video-harness serve <项目> --port 4173` 后访问 `/console/index.html`。
- 验收:持久化浏览器测试 `tests/console-browser.test.mjs`(五档宽度 1920/1440/1024/785/390;断言无溢出/SVG≤64px/恰好一个 active 面板/标签切换可见/截图哈希不同),截图存 `tests/console-shots/` 与 `console-验收截图/`。52 项测试全绿。
- P2 四阶段:Subtask1(止血:恢复总览样式作用域迁移 + 工作区标签控制器)已完成;待做 P2-1 假数据清除(workspace.html 仍硬编码 演示标题/540×960/17.126s/2026-08-02 时间)、P2-2 写操作闭环(审批/推进/编辑 preview→apply/批注/单场景返工/单段音频)、P2-3 多项目扫描。
- 并行化竞态已修:`compile.mjs` 跳过 running 与 failed 场景的 inputHash 检测(失败场景不被同伴完成覆盖成 stale)。

## 未提交内容(2026-08-04,禁止清理/重置)

- `indextts2.mjs` 有未提交修改(约 5 行):subst 输出按 GBK 解码(TextDecoder),修中文 Windows 下 subst 映射乱码误判。这是有价值的修复,保留;是否提交由用户决定。
- 未跟踪用户素材:两张 png(ChatGPT Image 2026年8月3日 21_06_35.png、background.png)、两个参考音频 mp3(养老金…、视频创作…)、`console-验收截图/` 目录。全部保留,不提交 git(素材与验收产物)。

## 新窗口视频制作验证指引(2026-08-04)

- 音色已就绪:`voice-profile.json`(indextts2 + assets/reference/owner.wav,speed 1.1,情绪文本)在 demo 项目 `runs/video-demo-20260803`。
- 场景生成已并行化:3 场景约 22min(串行 50min),`HYPERFRAMES_SCENE_CONCURRENCY` 默认 3。
- 字幕 words 已逐词 + 简体(whisper tokens 聚合)。
- 注意:GPU 8GiB 只能同时跑一个 IndexTTS2 推理;另一个项目(01_视频项目/2026-08-03_首发01_MG视频是什么)可能占用显存,合成前先查 nvidia-smi。
- 入口:`tools/video-harness.ps1`(init/advance/approve/audio/captions/render/serve)。