import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAudio } from "../lib/audio.mjs";
import { generateCaptions, setCaptionOverride } from "../lib/captions.mjs";
import { compileProject } from "../lib/compile.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { approve } from "../lib/state.mjs";

test("模拟 TTS 用真实时间轴驱动分镜并生成中文字幕", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "视频Harness音频-")), "project"), {
    title: "自动字幕",
    initialText: "字幕可以完全自动化。",
  });
  const script = readJson(join(root, "script.json"));
  script.segments.push({
    id: "line-002",
    sceneId: "scene-002",
    label: "落点",
    text: "修改某个场景，也只需要返工这个场景。",
    delivery: "自然坚定",
    pauseAfter: 0.2,
    locked: false,
  });
  writeJson(join(root, "script.json"), script);
  compileProject(root);
  approve(root, "script");
  const audio = generateAudio(root, { mock: true });
  assert.equal(audio.voices.length, 2);
  assert.equal(readFileSync(join(root, audio.voices[0].path), { encoding: "ascii", flag: "r" }).slice(0, 4), "RIFF");
  const storyboard = readJson(join(root, "storyboard.json"));
  assert.equal(storyboard.scenes.length, 2);
  assert.equal(storyboard.scenes[0].duration, audio.scene_durations["scene-001"]);
  compileProject(root, { requestStoryboardApproval: true });
  approve(root, "storyboard");
  const captions = generateCaptions(root);
  assert.ok(captions.groups.length >= 2);
  const srt = readFileSync(join(root, "captions", "captions.srt"), "utf8");
  assert.match(srt, /字幕可以完全自动化。/);
  assert.doesNotMatch(srt, /字 幕/);
  assert.match(readFileSync(join(root, "captions", "captions.vtt"), "utf8"), /^WEBVTT/);
  assert.match(readFileSync(join(root, "captions", "captions.ass"), "utf8"), /PlayResX:/);
  const first = captions.groups[0];
  setCaptionOverride(root, {
    id: first.id,
    text: "这句字幕已经人工精修。",
    start: first.start,
    end: first.end,
    style: { offsetY: -24, fontSize: 42 },
  });
  const revised = generateCaptions(root);
  assert.equal(revised.groups[0].text, "这句字幕已经人工精修。");
  assert.equal(revised.groups[0].style.offsetY, -24);
  assert.match(readFileSync(join(root, "captions", "captions.srt"), "utf8"), /人工精修/);
  assert.match(readFileSync(join(root, "captions", "captions.ass"), "utf8"), /\\pos\(/);
});
