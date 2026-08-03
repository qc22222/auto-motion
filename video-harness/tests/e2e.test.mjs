import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleProject } from "../lib/assemble.mjs";
import { generateAudio } from "../lib/audio.mjs";
import { generateCaptions } from "../lib/captions.mjs";
import { compileProject } from "../lib/compile.mjs";
import { PROJECT_FILES } from "../lib/constants.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { probeVideo, renderScenes } from "../lib/render.mjs";
import { assertReviewReady, generateReview } from "../lib/review.mjs";
import { buildScenes } from "../lib/scenes.mjs";
import { approve } from "../lib/state.mjs";
import { validateHarnessProject } from "../lib/validate.mjs";

test("无凭据模拟链路可从文案走到带音轨与字幕的成片", { timeout: 60_000 }, () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "视频Harness端到端-")), "project"), {
    title: "Harness 端到端",
    initialText: "确认文案，生成配音和字幕。",
  });
  const project = readJson(join(root, "project.json"));
  project.render.width = 320;
  project.render.height = 568;
  project.render.fps = 24;
  project.render.burnCaptions = true;
  writeJson(join(root, "project.json"), project);
  const design = readJson(join(root, "design.json"));
  design.layout.safeMarginX = 24;
  design.layout.safeMarginY = 30;
  writeJson(join(root, "design.json"), design);

  compileProject(root);
  approve(root, "script");
  generateAudio(root, { mock: true });
  compileProject(root, { requestStoryboardApproval: true });
  approve(root, "storyboard");
  generateCaptions(root);
  buildScenes(root, { mock: true });
  const review = generateReview(root);
  assert.equal(review.readyForApproval, true);
  assert.doesNotThrow(() => assertReviewReady(root));
  approve(root, "review");
  renderScenes(root, { mock: true });
  assert.throws(() => assembleProject(root), /模拟音频/);
  const audioMetaPath = join(root, PROJECT_FILES.audioMeta);
  const pendingAudioMeta = readJson(audioMetaPath);
  pendingAudioMeta.bgm_pending = true;
  writeJson(audioMetaPath, pendingAudioMeta);
  assert.throws(() => assembleProject(root, { allowMockAudio: true }), /背景音乐仍在生成或检索中/);
  pendingAudioMeta.bgm_pending = false;
  writeJson(audioMetaPath, pendingAudioMeta);
  const delivery = assembleProject(root, { allowMockAudio: true });
  assert.ok(existsSync(delivery.path));
  const probe = probeVideo(delivery.path);
  assert.ok(probe.streams.some((stream) => stream.codec_type === "video"));
  assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
  const report = validateHarnessProject(root, { mockAudio: true });
  assert.equal(report.ok, true, report.errors.join("\n"));
  const productionReport = validateHarnessProject(root);
  assert.equal(productionReport.ok, false);
  assert.match(productionReport.errors.join("\n"), /模拟音频/);
});
