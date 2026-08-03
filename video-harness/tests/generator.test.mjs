import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateScenes } from "../lib/generator.mjs";
import { generateAudio } from "../lib/audio.mjs";
import { compileProject } from "../lib/compile.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { approve, loadState } from "../lib/state.mjs";

test("场景生成桥接会顺序调用外部黑箱并验收 HyperFrames 源文件", { timeout: 60_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "video-harness-generator-"));
  const root = createProject(join(parent, "project"), {
    title: "黑箱桥接",
    initialText: "保留原来的视觉生成能力。",
  });
  const project = readJson(join(root, "project.json"));
  project.render.width = 320;
  project.render.height = 568;
  project.render.fps = 24;
  writeJson(join(root, "project.json"), project);
  compileProject(root);
  approve(root, "script");
  generateAudio(root, { mock: true });
  compileProject(root, { requestStoryboardApproval: true });
  approve(root, "storyboard");

  const runner = join(parent, "stub-scene-runner.mjs");
  writeFileSync(
    runner,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const requestPath = process.argv[process.argv.indexOf("--request") + 1];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
mkdirSync(dirname(request.outputSource), { recursive: true });
writeFileSync(request.outputSource, '<!doctype html><main data-composition-id="main" data-duration="' + request.duration + '" data-width="' + request.width + '" data-height="' + request.height + '"></main><script>window.__timelines = {};</script>');
console.log("[[USER_MESSAGE]]测试场景已生成：" + request.sceneId);
`,
    "utf8",
  );

  const results = await generateScenes(root, { runner, timeoutMs: 10_000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].sceneId, "scene-001");
  assert.equal(results[0].status, "complete");
  assert.equal(existsSync(join(root, "scenes", "scene-001", "project", "index.html")), true);
  const request = readJson(join(root, ".harness", "scene-builder", "scene-001.request.json"));
  assert.equal(request.width, 320);
  assert.equal(request.height, 568);
  assert.match(readFileSync(join(root, ".harness", "logs", "scene-001-generator.stdout.log"), "utf8"), /测试场景已生成/);
  assert.equal(loadState(root).sceneStates["scene-001"].status, "complete");
});
