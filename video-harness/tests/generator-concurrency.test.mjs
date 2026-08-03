import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { generateScenes } from "../lib/generator.mjs";
import { compileProject } from "../lib/compile.mjs";
import { loadState, setSceneStage } from "../lib/state.mjs";

// 构造三场景项目 fixture:script 3 段 + storyboard 3 场景。
function buildThreeSceneProject(parent) {
  const root = createProject(join(parent, "project"), {
    title: "并发场景测试",
    initialText: "第一段。",
  });
  const project = readJson(join(parent, "project", "project.json"));
  project.render.width = 160;
  project.render.height = 284;
  project.render.fps = 12;
  writeJson(join(parent, "project", "project.json"), project);
  writeJson(join(parent, "project", "script.json"), {
    schemaVersion: 1,
    title: "并发场景测试",
    segments: [
      { id: "line-001", sceneId: "scene-001", label: "一", text: "第一段。", delivery: "自然", pauseAfter: 0.1, locked: false },
      { id: "line-002", sceneId: "scene-002", label: "二", text: "第二段。", delivery: "自然", pauseAfter: 0.1, locked: false },
      { id: "line-003", sceneId: "scene-003", label: "三", text: "第三段。", delivery: "自然", pauseAfter: 0.1, locked: false },
    ],
  });
  const mk = (id, title, duration) => ({
    id,
    index: Number(id.slice(-1)),
    title,
    scriptIds: ["line-00" + id.slice(-1)],
    duration,
    transitionIn: "cut",
    status: "outline",
    summary: title,
    focal: title,
    blueprint: "compose",
    poster: 0.5,
    src: "scenes/" + id + "/project/index.html",
    durationSource: "estimate",
    extraHold: 0,
  });
  writeJson(join(parent, "project", "storyboard.json"), {
    schemaVersion: 1,
    message: "测试",
    arc: "A",
    audience: "t",
    scenes: [mk("scene-001", "一", 1.5), mk("scene-002", "二", 1.5), mk("scene-003", "三", 1.5)],
    totalDuration: 4.5,
  });
  return join(parent, "project");
}

// stub runner:启动/结束写时间戳到 trace;可选指定场景失败;延迟可配。
function stubRunner(parent, tracePath) {
  const runner = join(parent, "stub-scene-runner.mjs");
  writeFileSync(
    runner,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const requestPath = process.argv[process.argv.indexOf("--request") + 1];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const trace = process.env.STUB_TRACE;
const delay = Number(process.env.STUB_DELAY || 400);
appendFileSync(trace, "start:" + request.sceneId + ":" + Date.now() + "\\n");
await new Promise((r) => setTimeout(r, delay));
if (process.env.STUB_FAIL_SCENE === request.sceneId) {
  appendFileSync(trace, "fail:" + request.sceneId + "\\n");
  process.exit(1);
}
mkdirSync(dirname(request.outputSource), { recursive: true });
writeFileSync(request.outputSource, '<!doctype html><main data-composition-id="main" data-duration="' + request.duration + '" data-width="' + request.width + '" data-height="' + request.height + '"></main><script>window.__timelines = {};</script>');
appendFileSync(trace, "end:" + request.sceneId + ":" + Date.now() + "\\n");
`,
    "utf8",
  );
  return runner;
}

function runOptions(parent, tracePath, extra = {}) {
  process.env.STUB_TRACE = tracePath;
  return {
    runner: stubRunner(parent, tracePath),
    echo: false,
    concurrency: 3,
    ...extra,
  };
}

test("多个场景并发启动且全部成功", { timeout: 30_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "vh-conc-ok-"));
  const root = buildThreeSceneProject(parent);
  const tracePath = join(parent, "trace.log");
  const results = await generateScenes(root, runOptions(parent, tracePath));
  assert.equal(results.length, 3);
  const state = loadState(root);
  for (const id of ["scene-001", "scene-002", "scene-003"]) {
    assert.equal(state.sceneStates[id].status, "complete", id + " 应 complete");
    assert.ok(existsSync(join(root, "renders")), "渲染目录应被 buildScenes 准备");
  }
  const lines = readFileSync(tracePath, "utf8").trim().split("\n");
  const starts = lines.filter((l) => l.startsWith("start:")).map((l) => Number(l.split(":")[2]));
  assert.equal(starts.length, 3, "应有 3 个场景启动记录");
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(spread < 600, "场景应并发启动(时间差 " + spread + "ms;串行时 spread 应约 800ms)");
});

test("单个场景失败不影响其他场景,统一汇总失败", { timeout: 30_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "vh-conc-fail-"));
  const root = buildThreeSceneProject(parent);
  const tracePath = join(parent, "trace.log");
  const options = runOptions(parent, tracePath);
  process.env.STUB_FAIL_SCENE = "scene-002";
  try {
    await assert.rejects(
      () => generateScenes(root, options),
      /scene-002/,
      "应抛出包含失败场景的汇总错误",
    );
  } finally {
    delete process.env.STUB_FAIL_SCENE;
  }
  const state = loadState(root);
  assert.equal(state.sceneStates["scene-001"].status, "complete", "scene-001 应完成");
  assert.equal(state.sceneStates["scene-002"].status, "failed", "scene-002 应 failed");
  assert.equal(state.sceneStates["scene-003"].status, "complete", "scene-003 应完成");
  assert.equal(state.stages.scenes.status, "failed", "scenes 阶段应标记 failed");
});

test("并发度 1 时退化为串行执行", { timeout: 30_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "vh-conc-serial-"));
  const root = buildThreeSceneProject(parent);
  const tracePath = join(parent, "trace.log");
  const options = runOptions(parent, tracePath);
  options.concurrency = 1;
  const results = await generateScenes(root, options);
  assert.equal(results.length, 3);
  const lines = readFileSync(tracePath, "utf8").trim().split("\n");
  const starts = lines.filter((l) => l.startsWith("start:")).map((l) => Number(l.split(":")[2]));
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(spread >= 300, "并发度 1 时应串行启动(时间差 " + spread + "ms)");
});

test("compile 不把 running 场景误标 stale(并行竞态回归)", { timeout: 30_000 }, () => {
  const parent = mkdtempSync(join(tmpdir(), "vh-conc-race-"));
  const root = buildThreeSceneProject(parent);
  compileProject(root);
  const before = loadState(root);
  assert.notEqual(before.sceneStates["scene-001"].status, "running");
  // 模拟生成中:场景 running,且 inputHash 与 compile 重算值不同
  setSceneStage(root, "scene-001", "running", { inputHash: "fake-input-hash-different" });
  compileProject(root);
  const after = loadState(root);
  assert.equal(
    after.sceneStates["scene-001"].status,
    "running",
    "并行生成中的场景不应被 compile 的 inputHash 检测误标 stale",
  );
});