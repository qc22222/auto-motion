import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAudio } from "../lib/audio.mjs";
import { generateCaptions } from "../lib/captions.mjs";
import { compileProject } from "../lib/compile.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { addReviewComment, generateReview, prepareRevision } from "../lib/review.mjs";
import { renderScenes } from "../lib/render.mjs";
import { buildScenes } from "../lib/scenes.mjs";
import { approve, loadState } from "../lib/state.mjs";

test("场景批注只使被点名场景失效，并可独立返工", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "harness-revision-")), "project"), {
    initialText: "第一个场景。",
  });
  const script = readJson(join(root, "script.json"));
  script.segments.push({
    id: "line-002",
    sceneId: "scene-002",
    label: "第二场",
    text: "第二个场景保持不变。",
    delivery: "自然",
    pauseAfter: 0.1,
    locked: false,
  });
  writeJson(join(root, "script.json"), script);
  compileProject(root);
  approve(root, "script");
  generateAudio(root, { mock: true });
  compileProject(root, { requestStoryboardApproval: true });
  approve(root, "storyboard");
  generateCaptions(root);
  buildScenes(root, { mock: true });
  generateReview(root);
  approve(root, "review");

  addReviewComment(root, { sceneId: "scene-001", text: "标题再大一些。" });
  let state = loadState(root);
  assert.equal(state.sceneStates["scene-001"].status, "needs_revision");
  assert.equal(state.sceneStates["scene-002"].status, "complete");
  assert.equal(state.stages.captions.status, "complete");
  assert.equal(state.stages.review.status, "stale");
  const request = prepareRevision(root, "scene-001");
  assert.equal(request.comments.length, 1);
  assert.equal(existsSync(join(root, "scenes", "scene-001", "REVISION.md")), true);

  buildScenes(root, { sceneId: "scene-001", mock: true });
  state = loadState(root);
  assert.equal(state.sceneStates["scene-001"].status, "complete");
  assert.equal(state.sceneStates["scene-002"].status, "complete");
  assert.equal(generateReview(root).readyForApproval, true);

  renderScenes(root, { mock: true });
  appendFileSync(join(root, "scenes", "scene-001", "project", "index.html"), "\n<!-- scene-001 changed -->\n");
  appendFileSync(join(root, "scenes", "scene-002", "project", "index.html"), "\n<!-- scene-002 changed -->\n");
  buildScenes(root, { sceneId: "scene-001", accept: true });
  buildScenes(root, { sceneId: "scene-002", accept: true });
  renderScenes(root, { sceneId: "scene-001", mock: true });
  assert.equal(loadState(root).stages.render.status, "ready");
});
