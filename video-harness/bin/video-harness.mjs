#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assembleProject } from "../lib/assemble.mjs";
import { generateAudio } from "../lib/audio.mjs";
import { inspectAudioReadiness } from "../lib/audio-readiness.mjs";
import { generateCaptions, setCaptionOverride } from "../lib/captions.mjs";
import { compileProject } from "../lib/compile.mjs";
import { runDoctor } from "../lib/doctor.mjs";
import { appendJsonLine, nowIso, writeText } from "../lib/fs-utils.mjs";
import { generateScenes } from "../lib/generator.mjs";
import { createProject, projectRootFrom } from "../lib/model.mjs";
import { advanceProject } from "../lib/pipeline.mjs";
import { renderScenes } from "../lib/render.mjs";
import {
  addReviewComment,
  assertReviewReady,
  generateReview,
  prepareRevision,
} from "../lib/review.mjs";
import { buildScenes } from "../lib/scenes.mjs";
import { startHarnessServer } from "../lib/server.mjs";
import {
  approve,
  loadApprovals,
  loadState,
  requireApproval,
  requireStage,
} from "../lib/state.mjs";
import { validateHarnessProject } from "../lib/validate.mjs";

const STATUS_LABELS = {
  pending: "待开始",
  ready: "可执行",
  running: "执行中",
  needs_approval: "待批准",
  approved: "已批准",
  complete: "已完成",
  stale: "已过期",
  failed: "失败",
  needs_revision: "待返工",
};

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      options[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      options[key] = next;
      index++;
    } else {
      options[key] = true;
    }
  }
  return { positional, options };
}

function bool(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "是"].includes(String(value || "").toLowerCase());
}

function projectPath(options, positional, index = 0) {
  return projectRootFrom(resolve(options.project || positional[index] || process.cwd()));
}

function print(value, json = false) {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function printStatus(root, json) {
  const state = loadState(root);
  const approvals = loadApprovals(root);
  if (json) return print({ state, approvals }, true);
  console.log(`项目：${root}`);
  console.log(`模式：${state.mode}`);
  console.log("阶段：");
  for (const [stage, detail] of Object.entries(state.stages)) {
    const approval = approvals.records[stage]?.approvedAt ? " · 有批准记录" : "";
    console.log(`  ${stage.padEnd(12)} ${STATUS_LABELS[detail.status] || detail.status}${approval}`);
  }
  const scenes = Object.entries(state.sceneStates);
  if (scenes.length > 0) {
    console.log("场景：");
    for (const [sceneId, detail] of scenes) {
      console.log(`  ${sceneId.padEnd(18)} ${STATUS_LABELS[detail.status] || detail.status}`);
    }
  }
}

function help() {
  return `Video Harness · 项目本地视频产品内核

用法：
  video-harness doctor [项目目录]
  video-harness init <目录> [--title 标题] [--aspect 9:16|3:4|16:9] [--mode review|automation]
  video-harness compile [项目目录]
  video-harness validate [项目目录] [--mock-audio]
  video-harness status [项目目录]
  video-harness approve <script|storyboard|review> [项目目录] [--note 备注]
  video-harness audio [项目目录] [--mock]
  video-harness audio-check [项目目录]
  video-harness plan [项目目录]
  video-harness captions [项目目录]
  video-harness caption-set [项目目录] --id caption-001 [--text 文本] [--start 秒] [--end 秒] [--hide]
  video-harness build [项目目录] [--scene scene-001] [--mock|--accept]
  video-harness generate [项目目录] [--scene scene-001] [--runner runner.mjs] [--model 模型]
  video-harness review [项目目录]
  video-harness serve [项目目录] [--port 4173]
  video-harness comment [项目目录] --scene scene-001 --text "修改意见" [--pass final]
  video-harness revise [项目目录] --scene scene-001
  video-harness render [项目目录] [--scene scene-001] [--mock|--accept]
  video-harness assemble [项目目录] [--allow-mock-audio]
  video-harness advance [项目目录] [--runner runner.mjs] [--mock-audio] [--mock-render]
  video-harness run [项目目录] --mock --auto-approve

说明：
  - 所有依赖、技能、缓存和产物均留在当前视频制作项目或具体视频项目中。
  - 真实克隆音色必须先在 voice-profile.json 填写 voiceId，并把凭据写入视频项目的 .env。
  - build 默认只准备场景工程和人类可读任务单；外部工具完成代码后用 --accept 验收。
`;
}

function logOperation(root, command, status, detail = null) {
  if (!root || !existsSync(resolve(root, "project.json"))) return;
  appendJsonLine(resolve(root, ".harness", "history.jsonl"), {
    at: nowIso(),
    command,
    status,
    detail,
  });
}

async function runCommand(command, parsed) {
  const { positional, options } = parsed;
  const json = bool(options.json);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      print(help());
      return null;
    case "doctor": {
      const candidate = options.project || positional[0];
      const root = candidate ? resolve(candidate) : null;
      const report = runDoctor(root);
      if (json) print(report, true);
      else {
        console.log(`环境检查：${report.ok ? "通过" : "未通过"}`);
        for (const check of report.checks) {
          console.log(`  ${check.ok ? "✓" : check.required ? "✗" : "○"} ${check.name}：${check.detail}`);
        }
        console.log(`  凭据：HeyGen ${report.credentials.heygenConfigured || report.credentials.projectEnvExists ? "可能已配置" : "未检测到"}；ElevenLabs ${report.credentials.elevenlabsConfigured || report.credentials.projectEnvExists ? "可能已配置" : "未检测到"}`);
        console.log("  安装策略：仅项目本地，不使用全局安装");
      }
      if (!report.ok) process.exitCode = 1;
      return root;
    }
    case "init": {
      const target = positional[0];
      if (!target) throw new Error("init 需要目标目录");
      const root = createProject(target, {
        title: options.title,
        aspect: options.aspect,
        mode: options.mode,
        language: options.language,
        destination: options.destination,
        message: options.message,
        audience: options.audience,
        initialText: options.text,
      });
      const result = compileProject(root);
      print(json ? { root, ...result } : `项目已初始化：${root}\n下一步：编辑 script.json 和 voice-profile.json，然后执行 compile。`, json);
      return root;
    }
    case "compile": {
      const root = projectPath(options, positional);
      const result = compileProject(root);
      print(json ? result : `编译完成：${result.segments} 段旁白、${result.scenes} 个场景、${result.totalDuration}s（${result.durationSource}）`, json);
      return root;
    }
    case "validate": {
      const root = projectPath(options, positional);
      const report = validateHarnessProject(root, { mockAudio: bool(options["mock-audio"]) });
      if (json) print(report, true);
      else {
        console.log(`项目校验：${report.ok ? "通过" : "未通过"}`);
        for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);
        for (const error of report.errors) console.log(`  ✗ ${error}`);
      }
      if (!report.ok) process.exitCode = 1;
      return root;
    }
    case "status": {
      const root = projectPath(options, positional);
      printStatus(root, json);
      return root;
    }
    case "approve": {
      const stage = positional[0];
      if (!stage) throw new Error("approve 需要阶段名");
      const root = projectPath(options, positional, 1);
      if (stage === "review") assertReviewReady(root);
      const record = approve(root, stage, options.note || "");
      print(json ? record : `已批准阶段：${stage}`, json);
      return root;
    }
    case "audio": {
      const root = projectPath(options, positional);
      requireStage(root, "script", ["complete", "approved"]);
      requireApproval(root, "script", bool(options.force));
      const result = generateAudio(root, { mock: bool(options.mock), engine: options.engine });
      print(json ? result : `音频完成：${result.voices.length} 段，完整旁白 ${result.total_duration_s}s，模式 ${result.mock ? "模拟" : result.tts_provider}`, json);
      return root;
    }
    case "audio-check": {
      const root = projectPath(options, positional);
      const report = inspectAudioReadiness(root);
      if (json) print(report, true);
      else {
        console.log(`生产音频预检：${report.ready ? "通过" : "未通过"}`);
        console.log(`  路由：${report.provider} · 语言 ${report.language.requested} → ${report.language.engine} · 时间戳 ${report.wordTiming.mode}`);
        for (const check of report.checks) console.log(`  ${check.ok ? "✓" : "✗"} ${check.label}：${check.detail}`);
        for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);
      }
      if (!report.ready) process.exitCode = 1;
      return root;
    }
    case "plan": {
      const root = projectPath(options, positional);
      requireStage(root, "audio");
      const result = compileProject(root, { requestStoryboardApproval: true });
      writeText(resolve(root, ".harness", "prompts", "storyboard-review.md"), `# Storyboard 审阅\n\n请核对 \`STORYBOARD.md\` 中每个场景的语义、时长、视觉重点和转场。修改请直接落到 \`storyboard.json\`，然后重新执行 \`plan\`。\n`);
      print(json ? result : `分镜已按音频时长更新：${result.scenes} 个场景，共 ${result.totalDuration}s。请审阅 STORYBOARD.md 后批准 storyboard。`, json);
      return root;
    }
    case "captions": {
      const root = projectPath(options, positional);
      requireStage(root, "audio");
      requireStage(root, "storyboard", ["complete", "approved"]);
      requireApproval(root, "storyboard", bool(options.force));
      const result = generateCaptions(root);
      print(json ? result : `字幕完成：${result.groups.length} 组，已生成 JSON/SRT/VTT/ASS。`, json);
      return root;
    }
    case "caption-set": {
      const root = projectPath(options, positional);
      const style = {};
      if (options.x !== undefined) style.offsetX = Number(options.x);
      if (options.y !== undefined) style.offsetY = Number(options.y);
      if (options["font-size"] !== undefined) style.fontSize = Number(options["font-size"]);
      if (options.background !== undefined) style.background = options.background;
      if (options.color !== undefined) style.color = options.color;
      if (options["max-width"] !== undefined) style.maxWidth = options["max-width"];
      const result = setCaptionOverride(root, {
        id: options.id,
        text: options.text,
        start: options.start,
        end: options.end,
        hidden: options.hide ? true : options.unhide ? false : undefined,
        style,
      });
      print(json ? result : `已更新字幕覆盖：${result.captionId || result.id}。请重新执行 captions。`, json);
      return root;
    }
    case "build": {
      const root = projectPath(options, positional);
      requireStage(root, "storyboard", ["complete", "approved"]);
      requireApproval(root, "storyboard", bool(options.force));
      const result = buildScenes(root, {
        sceneId: options.scene,
        mock: bool(options.mock),
        accept: bool(options.accept),
      });
      print(json ? result : result.map((item) => `${item.sceneId}：${STATUS_LABELS[item.status] || item.status}`).join("\n"), json);
      return root;
    }
    case "generate": {
      const root = projectPath(options, positional);
      requireStage(root, "storyboard", ["complete", "approved"]);
      requireApproval(root, "storyboard", bool(options.force));
      const result = await generateScenes(root, {
        sceneId: options.scene,
        runner: options.runner,
        model: options.model,
        timeoutMs: options.timeout,
      });
      print(json ? result : result.map((item) => `${item.sceneId}：${STATUS_LABELS[item.status] || item.status}`).join("\n"), json);
      return root;
    }
    case "review": {
      const root = projectPath(options, positional);
      requireStage(root, "scenes");
      requireStage(root, "captions");
      const result = generateReview(root);
      print(json ? result : `审阅页已生成：reviews/index.html\n修改工作台：edit.html（建议执行 serve 后使用）\n可批准：${result.readyForApproval ? "是" : "否"}`, json);
      return root;
    }
    case "serve": {
      const root = projectPath(options, positional);
      const instance = await startHarnessServer(root, {
        host: options.host || "127.0.0.1",
        port: options.port == null ? 4173 : Number(options.port),
      });
      print(json ? { root, url: instance.url, review: `${instance.url}/reviews/index.html`, edit: `${instance.url}/edit` } : `本地审阅与修改工作台已启动：\n${instance.url}/reviews/index.html\n${instance.url}/edit\n\n按 Ctrl+C 停止服务。`, json);
      return root;
    }
    case "comment": {
      const root = projectPath(options, positional);
      const result = addReviewComment(root, {
        sceneId: options.scene,
        text: options.text,
        pass: options.pass,
      });
      print(json ? result : `已记录 ${result.sceneId} 的审阅意见，并只将该场景标记为待返工。`, json);
      return root;
    }
    case "revise": {
      const root = projectPath(options, positional);
      if (!options.scene) throw new Error("revise 需要 --scene");
      const result = prepareRevision(root, options.scene);
      print(json ? result : `局部返工任务已生成：scenes/${options.scene}/REVISION.md`, json);
      return root;
    }
    case "render": {
      const root = projectPath(options, positional);
      requireStage(root, "review", ["approved"]);
      requireApproval(root, "review", bool(options.force));
      const result = renderScenes(root, {
        sceneId: options.scene,
        mock: bool(options.mock),
        accept: bool(options.accept),
        quality: options.quality,
        timeoutMs: options.timeout,
      });
      print(json ? result : `渲染完成：${result.length} 个场景。`, json);
      return root;
    }
    case "assemble": {
      const root = projectPath(options, positional);
      requireStage(root, "render");
      const result = assembleProject(root, { allowMockAudio: bool(options["allow-mock-audio"]) });
      print(json ? result : `交付完成：${result.path}`, json);
      return root;
    }
    case "advance": {
      const root = projectPath(options, positional);
      const result = await advanceProject(root, {
        mockAudio: bool(options["mock-audio"]),
        mockRender: bool(options["mock-render"]),
        allowMockAudio: bool(options["allow-mock-audio"]) || bool(options["mock-audio"]),
        audioEngine: options.engine,
        runner: options.runner,
        model: options.model,
        quality: options.quality,
        timeoutMs: options.timeout,
      });
      print(json ? result : result.status === "complete" ? `流水线完成：${result.delivery}` : result.message, json);
      return root;
    }
    case "run": {
      const root = projectPath(options, positional);
      if (!bool(options.mock)) throw new Error("run 当前只允许显式使用 --mock；真实生产请逐阶段执行并审阅");
      if (!bool(options["auto-approve"])) throw new Error("run --mock 需要 --auto-approve，避免绕过未知审批意图");
      compileProject(root);
      approve(root, "script", "模拟端到端验收自动批准");
      generateAudio(root, { mock: true });
      compileProject(root, { requestStoryboardApproval: true });
      approve(root, "storyboard", "模拟端到端验收自动批准");
      generateCaptions(root);
      buildScenes(root, { mock: true });
      generateReview(root);
      assertReviewReady(root);
      approve(root, "review", "模拟端到端验收自动批准");
      renderScenes(root, { mock: true });
      const result = assembleProject(root, { allowMockAudio: true });
      print(json ? result : `模拟端到端流程完成：${result.path}`, json);
      return root;
    }
    default:
      throw new Error(`未知命令：${command}\n\n${help()}`);
  }
}

const command = process.argv[2] || "help";
const parsed = parseArgs(process.argv.slice(3));
let operationRoot = null;
try {
  operationRoot = await runCommand(command, parsed);
  logOperation(operationRoot, command, "success");
} catch (error) {
  const candidate = parsed.options.project || parsed.positional.find((value) => existsSync(resolve(value, "project.json")));
  operationRoot = candidate ? resolve(candidate) : operationRoot;
  logOperation(operationRoot, command, "failed", error.message);
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
