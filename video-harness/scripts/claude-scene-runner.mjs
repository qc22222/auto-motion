#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function resolveClaudeBinary(env = process.env, platform = process.platform) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (platform === "win32") {
    const candidates = [
      env.APPDATA
        ? join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
        : null,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "Claude", "claude.exe") : null,
    ].filter(Boolean);
    const binary = candidates.find((candidate) => existsSync(candidate));
    if (binary) return binary;
    throw new Error("未找到 Claude Code 原生命令；可通过 CLAUDE_BIN 指定 claude.exe 的绝对路径");
  }
  return "claude";
}

export function buildClaudePrompt(request) {
  return `读取并严格执行当前场景任务单：${request.promptPath}

这是一次非交互式的单场景 MG 动画制作。保留现有 auto-motion 黑箱中已经有效的创作方式：你负责本场景的视觉概念、素材判断、动画代码、检查与渲染；外层 Video Harness 只提供真实时长、项目契约和验收，不替你套用固定模板。

创作要求：
1. 先阅读完整 BRIEF、frame、STORYBOARD、SCRIPT 和本场景任务单，理解当前旁白在全片中的语义位置。
2. 不要复用当前占位画面，也不要把信息机械堆成通用卡片；围绕文案建立一个清晰、场景专属的视觉概念。
3. 遇到品牌、产品或不熟悉的专有名词时先查证；需要明确 logo 或视觉资产而项目内没有时，联网获取可靠素材并保存到本场景的本地 assets 目录。
4. 字幕和音轨由总装层统一处理，本场景不要重复烧录完整字幕，也不要添加音轨。
5. 动画必须可按任意时间点确定性求值，禁止 Date.now、Math.random、无限动画和运行时网络请求。

工程边界：
- 现有 HyperFrames 工程已经位于：${request.projectDir}
- 不要重新执行 init，只修改该工程及本场景必要的本地素材。
- 共享技能模板位于：${request.sharedTemplateRoot}
- 所有 HyperFrames lint、check、snapshot、render 均使用工程内的 hyperframes-local.ps1，禁止运行 hyperframes skills 或安装全局技能。
- 画布 ${request.width}×${request.height}，${request.fps}fps，精确时长 ${request.duration} 秒。
- 源文件必须交付到：${request.outputSource}
- 通过 lint/check 后，把无音轨场景渲染到：${request.outputRender}

不要向用户提问，直接完成。关键阶段分别输出以下独立行：
[[USER_MESSAGE]]需求理解和素材检查已完成
[[USER_MESSAGE]]开始场景视觉实现
[[USER_MESSAGE]]代码已完成，开始检查与渲染
[[USER_MESSAGE]]视频已渲染完成：${request.sceneId}
`;
}

function emitUserMessages(line) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return;
  }
  if (item?.type !== "assistant") return;
  for (const content of item.message?.content || []) {
    if (content?.type !== "text") continue;
    for (const textLine of String(content.text || "").split("\n")) {
      if (textLine.startsWith("[[USER_MESSAGE]]")) console.log(textLine);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const requestPath = option(argv, "--request");
  if (!requestPath) throw new Error("缺少 --request <场景请求 JSON>");
  const request = JSON.parse(readFileSync(resolve(requestPath), "utf8"));
  for (const field of ["sceneRoot", "sceneId", "promptPath", "projectDir", "outputSource", "outputRender", "sharedTemplateRoot"]) {
    if (!request[field]) throw new Error(`场景请求缺少字段：${field}`);
  }
  if (!existsSync(request.promptPath)) throw new Error(`场景任务单不存在：${request.promptPath}`);
  if (!existsSync(request.projectDir)) throw new Error(`场景工程不存在：${request.projectDir}`);
  if (!existsSync(request.sharedTemplateRoot)) throw new Error(`共享技能模板不存在：${request.sharedTemplateRoot}`);

  const rawLogPath = join(request.sceneRoot, `claude-${request.sceneId}.stream.jsonl`);
  const stderrLogPath = join(request.sceneRoot, `claude-${request.sceneId}.stderr.log`);
  const rawLog = createWriteStream(rawLogPath, { encoding: "utf8" });
  const stderrLog = createWriteStream(stderrLogPath, { encoding: "utf8" });
  const args = [
    "-p",
    "--add-dir",
    request.sharedTemplateRoot,
    "--dangerously-skip-permissions",
    "--verbose",
    "--output-format",
    "stream-json",
    "--prompt-suggestions",
    "false",
  ];
  if (request.model) args.push("--model", request.model);
  args.push(buildClaudePrompt(request));

  const child = spawn(resolveClaudeBinary(), args, {
    cwd: request.sceneRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let lineBuffer = "";
  child.stdout.on("data", (chunk) => {
    rawLog.write(chunk);
    lineBuffer += chunk.toString();
    let newline = lineBuffer.indexOf("\n");
    while (newline >= 0) {
      emitUserMessages(lineBuffer.slice(0, newline));
      lineBuffer = lineBuffer.slice(newline + 1);
      newline = lineBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrLog.write(chunk);
    process.stderr.write(chunk);
  });

  const exit = await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });
  if (lineBuffer) emitUserMessages(lineBuffer);
  rawLog.end();
  stderrLog.end();
  await Promise.allSettled([finished(rawLog), finished(stderrLog)]);
  if (exit.code !== 0) {
    throw new Error(`Claude 场景生成失败（退出码 ${exit.code ?? "未知"}${exit.signal ? `，信号 ${exit.signal}` : ""}）`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
