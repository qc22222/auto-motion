# 项目规则

- `PROMPT.md` 要像直接写给人类操作者的任务说明，不要暴露执行这份说明的是 agent、Codex 或 AI，也不要使用“主控 agent”这类身份设定；但可以明确说明他需要操作其他AI。
- Windows 中文路径下禁止直接执行 `npx hyperframes init`。新建 HyperFrames 工程必须使用 `tools/hyperframes-local.ps1 init ...`；镜头模板目录中使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 init ...`。
- HyperFrames 的 `lint`、`check`、`snapshot`、`preview`、`render` 等命令也优先通过上述本地安全入口执行。禁止运行 `hyperframes skills`，技能只维护在 `exampleFolder/.claude/skills`。
