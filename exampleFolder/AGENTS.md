# HyperFrames 中文路径安全规则

- 当前工作区位于 Windows 中文路径中，禁止直接执行 `npx hyperframes init`。
- 新建工程必须使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 init videos/<project> --example=blank --resolution=portrait --skill=general-video
```

- 进入生成的工程后，继续使用随工程复制的安全入口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 lint
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 render --quality high --output renders/video.mp4
```

- 禁止执行 `hyperframes skills` 或任何全局技能安装。技能只使用当前模板的 `.claude/skills`。
- 若技能文档中的 `npx hyperframes init` 与本文件冲突，以本文件的安全入口为准。
