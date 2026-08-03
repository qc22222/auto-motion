import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileProject } from "../lib/compile.mjs";
import { assertEmptyOrMissing, readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject, loadProjectModel, validateProjectModel } from "../lib/model.mjs";
import {
  approve,
  invalidateFrom,
  loadApprovals,
  loadState,
  setStage,
} from "../lib/state.mjs";

test("空目录检测会拒绝非空目录", () => {
  const root = mkdtempSync(join(tmpdir(), "video-harness-empty-"));
  assert.doesNotThrow(() => assertEmptyOrMissing(root));
  writeFileSync(join(root, "occupied.txt"), "x");
  assert.throws(() => assertEmptyOrMissing(root), /非空/);
});

test("编译会生成兼容文档和场景级配置", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-model-")), "project"), {
    title: "字幕自动化测试",
    initialText: "字幕可以从确认文案直接生成。",
  });
  const result = compileProject(root);
  assert.equal(result.scenes, 1);
  assert.equal(result.segments, 1);
  for (const file of ["BRIEF.md", "SCRIPT.md", "frame.md", "STORYBOARD.md", "audio_request.json"]) {
    assert.equal(existsSync(join(root, file)), true, file);
  }
  assert.equal(readJson(join(root, "scenes", "scene-001", "scene.config.json")).sceneId, "scene-001");
  assert.equal(readJson(join(root, "scenes", "scene-001", "shot-plan.json")).narration, "字幕可以从确认文案直接生成。");
  const scenePrompt = readFileSync(join(root, "scenes", "scene-001", "PROMPT.md"), "utf8");
  assert.match(scenePrompt, /`\.\.\/\.\.\/BRIEF\.md`/);
  assert.match(scenePrompt, /`\.\/shot-plan\.json`/);
  assert.doesNotMatch(scenePrompt, /`\.\.\/\.\.\/\.\.\/BRIEF\.md`/);
});

test("ElevenLabs 音色设置与发音词典会进入真实音频任务契约", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-elevenlabs-contract-")), "project"), {
    initialText: "原生时间戳配音测试。",
  });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "elevenlabs";
  voice.voiceId = "authorized-elevenlabs-voice";
  voice.cloneRequired = false;
  voice.speed = 1.1;
  voice.settings = { stability: 0.4, similarityBoost: 0.8, useSpeakerBoost: true };
  voice.pronunciations = { dictionaries: ["dictionary-id:version-id"] };
  writeJson(join(root, "voice-profile.json"), voice);
  compileProject(root);
  const request = readJson(join(root, "audio_request.json"));
  assert.equal(request.tts.cache, true);
  assert.deepEqual(request.settings, voice.settings);
  assert.deepEqual(request.pronunciations, voice.pronunciations);
});

test("ElevenLabs 参数在进入外部引擎前按官方范围校验", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-elevenlabs-validate-")), "project"), {
    initialText: "参数边界测试。",
  });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "elevenlabs";
  voice.voiceId = "authorized-elevenlabs-voice";
  voice.cloneRequired = false;
  voice.speed = 1.3;
  voice.settings = { stability: 1.2, useSpeakerBoost: "yes" };
  voice.pronunciations = { dictionaries: ["缺少版本号"] };
  writeJson(join(root, "voice-profile.json"), voice);
  const validation = validateProjectModel(loadProjectModel(root));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /0\.7 到 1\.2/);
  assert.match(validation.errors.join("\n"), /stability/);
  assert.match(validation.errors.join("\n"), /useSpeakerBoost/);
  assert.match(validation.errors.join("\n"), /dictionaryId:versionId/);
});

test("IndexTTS2 契约会携带授权参考音频和情绪控制，并拒绝未授权或非法向量", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-indextts2-contract-")), "project"), {
    initialText: "本地 GPU 克隆音色测试。",
  });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "indextts2";
  voice.voiceId = "";
  voice.cloneRequired = true;
  voice.referenceAudio = "assets/reference/owner.wav";
  voice.referenceAudioAuthorized = true;
  voice.settings = { emotionMode: "delivery", emotionWeight: 0.6 };
  writeJson(join(root, "voice-profile.json"), voice);
  compileProject(root);
  const request = readJson(join(root, "audio_request.json"));
  assert.equal(request.referenceAudio, "assets/reference/owner.wav");
  assert.equal(request.referenceAudioAuthorized, true);
  assert.equal(request.settings.emotionMode, "delivery");

  voice.referenceAudioAuthorized = false;
  voice.settings = { emotionMode: "vector", emotionVector: "0.5,0.5,0,0,0,0,0,0" };
  writeJson(join(root, "voice-profile.json"), voice);
  const validation = validateProjectModel(loadProjectModel(root));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /参考音频授权/);
  assert.match(validation.errors.join("\n"), /总和不得超过 0\.8/);
});

test("混音母带与侧链参数会在装配前进行边界校验", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-mastering-validate-")), "project"), {
    initialText: "混音参数边界测试。",
  });
  const project = readJson(join(root, "project.json"));
  project.audio.mastering = {
    narrationLufs: -30,
    mixLufs: -14,
    truePeakDb: 1,
    ducking: { enabled: true, threshold: 2, ratio: 0.5, attackMs: -1, releaseMs: 0 },
  };
  writeJson(join(root, "project.json"), project);
  const validation = validateProjectModel(loadProjectModel(root));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /narrationLufs/);
  assert.match(validation.errors.join("\n"), /truePeakDb/);
  assert.match(validation.errors.join("\n"), /threshold/);
  assert.match(validation.errors.join("\n"), /ratio/);
  assert.match(validation.errors.join("\n"), /attackMs/);
  assert.match(validation.errors.join("\n"), /releaseMs/);
});

test("状态失效按依赖图传播，不误伤独立设计阶段", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-state-")), "project"), {
    initialText: "依赖图测试。",
  });
  compileProject(root);
  approve(root, "script");
  setStage(root, "audio", "complete");
  setStage(root, "storyboard", "complete");
  setStage(root, "design", "complete");
  setStage(root, "captions", "complete");
  invalidateFrom(root, "audio");
  const state = loadState(root);
  assert.equal(state.stages.script.status, "approved");
  assert.equal(state.stages.design.status, "complete");
  assert.equal(state.stages.audio.status, "stale");
  assert.equal(state.stages.storyboard.status, "stale");
  assert.equal(state.stages.captions.status, "stale");
  assert.ok(loadApprovals(root).records.script);
});

test("审批不能绕过尚未到达的质量门", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "video-harness-approval-")), "project"), {
    initialText: "审批门测试。",
  });
  assert.throws(() => approve(root, "storyboard"), /不能批准/);
  compileProject(root);
  assert.doesNotThrow(() => approve(root, "script"));
});
