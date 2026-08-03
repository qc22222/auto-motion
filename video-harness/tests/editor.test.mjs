import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAudio } from "../lib/audio.mjs";
import { generateCaptions } from "../lib/captions.mjs";
import { compileProject } from "../lib/compile.mjs";
import {
  applyProjectEdit,
  getEditCatalog,
  previewProjectEdit,
} from "../lib/editor.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { generateReview } from "../lib/review.mjs";
import { buildScenes } from "../lib/scenes.mjs";
import { approve, loadApprovals, loadState } from "../lib/state.mjs";

function createReviewProject() {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "harness-editor-")), "project"), {
    title: "分环节修改测试",
    initialText: "第一段旁白用于测试修改影响。",
  });
  const script = readJson(join(root, "script.json"));
  script.segments.push({
    id: "line-002",
    sceneId: "scene-002",
    label: "第二场",
    text: "第二个镜头应当保持不变。",
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
  return root;
}

test("修改目录按环节提供不同字段，而不是通用 JSON 编辑器", () => {
  const root = createReviewProject();
  const catalog = getEditCatalog(root);
  const byTarget = new Map(catalog.sections.map((section) => [section.target, section]));
  assert.deepEqual(
    [...byTarget.keys()],
    ["project", "script", "voice", "storyboard", "design", "scene", "caption", "delivery"],
  );
  assert.ok(byTarget.get("script").fields.some((field) => field.name === "pauseAfter"));
  assert.ok(byTarget.get("voice").fields.some((field) => field.name === "provider"));
  assert.deepEqual(
    byTarget.get("voice").fields.find((field) => field.name === "settings.stability").appliesToProviders,
    ["elevenlabs"],
  );
  assert.deepEqual(
    byTarget.get("voice").fields.find((field) => field.name === "pronunciations.dictionaries").appliesToProviders,
    ["elevenlabs"],
  );
  assert.equal(
    byTarget.get("voice").fields.find((field) => field.name === "speed").providerConstraints.elevenlabs.max,
    1.2,
  );
  assert.deepEqual(
    byTarget.get("voice").fields.find((field) => field.name === "referenceAudio").appliesToProviders,
    ["indextts2"],
  );
  assert.deepEqual(
    byTarget.get("voice").fields.find((field) => field.name === "settings.emotionMode").appliesToProviders,
    ["indextts2"],
  );
  assert.ok(byTarget.get("storyboard").fields.some((field) => field.name === "extraHold"));
  assert.ok(byTarget.get("scene").fields.some((field) => field.name === "visualPlan.opening"));
  assert.ok(byTarget.get("caption").fields.some((field) => field.name === "style.fontSize"));
  assert.ok(byTarget.get("delivery").fields.some((field) => field.name === "burnCaptions"));
  assert.ok(byTarget.get("delivery").fields.some((field) => field.name === "tts.cache"));
  assert.deepEqual(
    byTarget.get("delivery").fields.find((field) => field.name === "bgm.volume").impact.stages,
    ["delivery"],
  );
  assert.deepEqual(
    byTarget.get("delivery").fields.find((field) => field.name === "mastering.mixLufs").impact.stages,
    ["delivery"],
  );
  assert.equal(byTarget.get("scene").fields.some((field) => field.type === "json"), false);
  const reviewHtml = readFileSync(join(root, "reviews", "index.html"), "utf8");
  const editHtml = readFileSync(join(root, "edit.html"), "utf8");
  assert.match(reviewHtml, /修改这个画面/);
  assert.match(reviewHtml, /target=caption/);
  assert.match(editHtml, /分环节修改工作台/);
});

test("旁白文本修改会预览并失效完整下游，且旧预览不能直接应用", () => {
  const root = createReviewProject();
  const request = {
    target: "script",
    id: "line-001",
    changes: { text: "这是经过精修的新旁白。" },
  };
  const preview = previewProjectEdit(root, request);
  assert.deepEqual(preview.impact.stages, [
    "script",
    "audio",
    "storyboard",
    "scenes",
    "captions",
    "review",
    "render",
    "delivery",
  ]);
  assert.equal(preview.impact.sceneScope, "all");
  assert.deepEqual(preview.impact.approvalsCleared, ["script", "storyboard", "review"]);
  assert.throws(
    () => applyProjectEdit(root, request, { expectedFingerprint: "stale-preview" }),
    /预览已过期/,
  );
  const result = applyProjectEdit(root, request, { expectedFingerprint: preview.fingerprint });
  assert.equal(result.changed, true);
  assert.equal(readJson(join(root, "script.json")).segments[0].text, "这是经过精修的新旁白。");
  const state = loadState(root);
  assert.equal(state.stages.script.status, "needs_approval");
  assert.equal(state.stages.audio.status, "stale");
  assert.equal(state.stages.storyboard.status, "pending");
  assert.equal(state.sceneStates["scene-001"].status, "stale");
  assert.equal(state.sceneStates["scene-002"].status, "stale");
  assert.equal(loadApprovals(root).records.script, undefined);
  assert.throws(
    () => previewProjectEdit(root, { ...request, changes: { arbitrary: "禁止" } }),
    /不支持修改字段/,
  );
});

test("单镜头画面修改只返工目标镜头，不使字幕和其他镜头过期", () => {
  const root = createReviewProject();
  const request = {
    target: "scene",
    id: "scene-001",
    changes: {
      "visualPlan.opening": "先用一个明确的主体特写建立视觉锚点",
      manualNotes: "保留当前构图，只增强标题层级。",
    },
  };
  const preview = previewProjectEdit(root, request);
  assert.deepEqual(preview.impact.stages, ["scenes", "review", "render", "delivery"]);
  assert.deepEqual(preview.impact.sceneIds, ["scene-001"]);
  applyProjectEdit(root, request, { expectedFingerprint: preview.fingerprint });
  const plan = readJson(join(root, "scenes", "scene-001", "shot-plan.json"));
  assert.equal(plan.visualPlan.opening, "先用一个明确的主体特写建立视觉锚点");
  assert.equal(plan.manualNotes, "保留当前构图，只增强标题层级。");
  const state = loadState(root);
  assert.equal(state.sceneStates["scene-001"].status, "stale");
  assert.equal(state.sceneStates["scene-002"].status, "complete");
  assert.equal(state.stages.captions.status, "complete");
  assert.equal(state.stages.review.status, "stale");
  assert.ok(loadApprovals(root).records.storyboard);
  assert.equal(loadApprovals(root).records.review, undefined);
});

test("分镜视觉参数与额外停留采用不同失效范围", () => {
  const visualRoot = createReviewProject();
  const visualRequest = {
    target: "storyboard",
    id: "scene-001",
    changes: { focal: "人物手部动作", poster: 0.8 },
  };
  const visualPreview = previewProjectEdit(visualRoot, visualRequest);
  assert.deepEqual(visualPreview.impact.stages, ["storyboard", "scenes", "review", "render", "delivery"]);
  applyProjectEdit(visualRoot, visualRequest, { expectedFingerprint: visualPreview.fingerprint });
  let state = loadState(visualRoot);
  assert.equal(state.stages.storyboard.status, "needs_approval");
  assert.equal(state.stages.audio.status, "complete");
  assert.equal(state.stages.captions.status, "complete");
  assert.equal(state.sceneStates["scene-001"].status, "stale");
  assert.equal(state.sceneStates["scene-002"].status, "complete");

  const timingRoot = createReviewProject();
  const timingRequest = {
    target: "storyboard",
    id: "scene-001",
    changes: { extraHold: 1.2 },
  };
  const timingPreview = previewProjectEdit(timingRoot, timingRequest);
  assert.ok(timingPreview.impact.stages.includes("audio"));
  assert.ok(timingPreview.impact.stages.includes("captions"));
  applyProjectEdit(timingRoot, timingRequest, { expectedFingerprint: timingPreview.fingerprint });
  state = loadState(timingRoot);
  assert.equal(state.stages.audio.status, "stale");
  assert.equal(state.stages.storyboard.status, "pending");
  assert.equal(state.stages.captions.status, "stale");
  assert.equal(state.sceneStates["scene-001"].status, "stale");
  assert.equal(state.sceneStates["scene-002"].status, "complete");
});

test("字幕修改只影响字幕下游，并可重新生成精修字幕", () => {
  const root = createReviewProject();
  const caption = readJson(join(root, "captions", "captions.json")).groups[0];
  const request = {
    target: "caption",
    id: caption.id,
    changes: { text: "这是一条人工精修字幕。", "style.fontSize": 46 },
  };
  const preview = previewProjectEdit(root, request);
  assert.deepEqual(preview.impact.stages, ["captions", "review", "render", "delivery"]);
  applyProjectEdit(root, request, { expectedFingerprint: preview.fingerprint });
  let state = loadState(root);
  assert.equal(state.stages.audio.status, "complete");
  assert.equal(state.stages.scenes.status, "complete");
  assert.equal(state.stages.captions.status, "stale");
  assert.equal(state.sceneStates["scene-001"].status, "complete");
  const output = generateCaptions(root);
  assert.equal(output.groups[0].text, "这是一条人工精修字幕。");
  assert.equal(output.groups[0].style.fontSize, 46);
  state = loadState(root);
  assert.equal(state.stages.captions.status, "complete");
});
