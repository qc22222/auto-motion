import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { advanceProject } from "../lib/pipeline.mjs";
import { approve } from "../lib/state.mjs";

test("advance 会自动推进确定性阶段，并只在三个质量门暂停", { timeout: 60_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "video-harness-pipeline-"));
  const root = createProject(join(parent, "project"), {
    title: "可恢复流水线",
    initialText: "真实时间轴驱动完整视频流水线。",
  });
  const project = readJson(join(root, "project.json"));
  project.render.width = 160;
  project.render.height = 284;
  project.render.fps = 12;
  writeJson(join(root, "project.json"), project);

  const runner = join(parent, "stub-scene-runner.mjs");
  writeFileSync(
    runner,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const requestPath = process.argv[process.argv.indexOf("--request") + 1];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
mkdirSync(dirname(request.outputSource), { recursive: true });
writeFileSync(request.outputSource, '<!doctype html><main data-composition-id="main" data-duration="' + request.duration + '" data-width="' + request.width + '" data-height="' + request.height + '"></main><script>window.__timelines = {};</script>');
`,
    "utf8",
  );

  const options = {
    mockAudio: true,
    mockRender: true,
    allowMockAudio: true,
    runner,
    echo: false,
  };
  const scriptGate = await advanceProject(root, options);
  assert.equal(scriptGate.status, "waiting_approval");
  assert.equal(scriptGate.stage, "script");

  approve(root, "script", "测试批准文案");
  const storyboardGate = await advanceProject(root, options);
  assert.equal(storyboardGate.status, "waiting_approval");
  assert.equal(storyboardGate.stage, "storyboard");

  approve(root, "storyboard", "测试批准分镜");
  const reviewGate = await advanceProject(root, options);
  assert.equal(reviewGate.status, "waiting_approval");
  assert.equal(reviewGate.stage, "review");

  approve(root, "review", "测试批准审阅");
  const completed = await advanceProject(root, options);
  assert.equal(completed.status, "complete");
  assert.equal(existsSync(join(root, "delivery", "final.mp4")), true);
});
