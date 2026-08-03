import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAudio } from "../lib/audio.mjs";
import { inspectAudioReadiness } from "../lib/audio-readiness.mjs";
import { compileProject } from "../lib/compile.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { approve } from "../lib/state.mjs";

function project() {
  return createProject(join(mkdtempSync(join(tmpdir(), "harness-audio-ready-")), "project"), {
    initialText: "生产音频预检。",
  });
}

test("HeyGen 项目缺少凭据和克隆音色时不能被误报为生产就绪", () => {
  const root = project();
  const report = inspectAudioReadiness(root, {
    capabilities: { heygenCredential: false },
  });
  assert.equal(report.provider, "heygen");
  assert.equal(report.ready, false);
  assert.match(report.errors.join("\n"), /凭据/);
  assert.match(report.errors.join("\n"), /voiceId/);
  assert.equal(report.wordTiming.mode, "native");
});

test("HeyGen 具备凭据和 voiceId 时通过本地生产预检，但保留远程验证提示", () => {
  const root = project();
  const voice = readJson(join(root, "voice-profile.json"));
  voice.voiceId = "authorized-clone-id";
  writeJson(join(root, "voice-profile.json"), voice);
  const report = inspectAudioReadiness(root, {
    capabilities: { heygenCredential: true },
  });
  assert.equal(report.ready, true, report.errors.join("\n"));
  assert.ok(report.warnings.some((warning) => /远程/.test(warning)));
  assert.ok(report.effectiveControls.includes("speed"));
});

test("ElevenLabs 使用原生时间戳，不依赖 Python 包或二次字词对齐", () => {
  const root = project();
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "elevenlabs";
  voice.voiceId = "authorized-elevenlabs-voice";
  voice.cloneRequired = false;
  voice.speed = 1.1;
  voice.settings = { stability: 0.4, similarityBoost: 0.8 };
  voice.pronunciations = { dictionaries: ["dictionary-id:version-id"] };
  writeJson(join(root, "voice-profile.json"), voice);

  const report = inspectAudioReadiness(root, {
    capabilities: { elevenlabsKey: true, elevenlabsPackage: false, alignment: false },
  });
  assert.equal(report.ready, true, report.errors.join("\n"));
  assert.equal(report.wordTiming.mode, "native");
  assert.equal(report.wordTiming.ready, true);
  assert.ok(report.effectiveControls.includes("speed"));
  assert.ok(report.effectiveControls.includes("settings"));
  assert.ok(report.effectiveControls.includes("pronunciations"));
  assert.equal(report.unsupportedControls.includes("settings"), false);
  assert.equal(report.unsupportedControls.includes("pronunciations"), false);
  assert.ok(report.warnings.some((warning) => /远程/.test(warning)));
});

test("Kokoro 中文路线需要本地依赖、明确音色和字词对齐能力", () => {
  const root = project();
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "kokoro";
  voice.voiceId = "zf_xiaobei";
  voice.cloneRequired = false;
  voice.language = "zh-CN";
  writeJson(join(root, "voice-profile.json"), voice);

  const blocked = inspectAudioReadiness(root, {
    capabilities: { kokoroCli: true, kokoroPython: true, alignment: false },
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.errors.join("\n"), /字词对齐/);

  const ready = inspectAudioReadiness(root, {
    capabilities: { kokoroCli: true, kokoroPython: true, alignment: true },
  });
  assert.equal(ready.ready, true, ready.errors.join("\n"));
  assert.equal(ready.language.engine, "zh");
  assert.equal(ready.wordTiming.mode, "alignment");
  assert.ok(ready.effectiveControls.includes("speed"));
});

test("Kokoro 不能冒充克隆音色路线", () => {
  const root = project();
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "kokoro";
  voice.voiceId = "zf_xiaobei";
  voice.cloneRequired = true;
  writeJson(join(root, "voice-profile.json"), voice);
  const report = inspectAudioReadiness(root, {
    capabilities: { kokoroCli: true, kokoroPython: true, alignment: true },
  });
  assert.equal(report.ready, false);
  assert.match(report.errors.join("\n"), /不支持克隆音色/);
});

test("IndexTTS2 只有在授权参考音频、完整模型、CUDA 和字词对齐全部可用时才生产就绪", () => {
  const root = project();
  const referenceDir = join(root, "assets", "reference");
  mkdirSync(referenceDir, { recursive: true });
  writeFileSync(join(referenceDir, "owner.wav"), "authorized-reference-audio");
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "indextts2";
  voice.voiceId = "";
  voice.cloneRequired = true;
  voice.referenceAudio = "assets/reference/owner.wav";
  voice.referenceAudioAuthorized = true;
  voice.settings = { emotionMode: "delivery", emotionWeight: 0.6 };
  writeJson(join(root, "voice-profile.json"), voice);

  const blocked = inspectAudioReadiness(root, {
    capabilities: {
      indexTtsRuntime: true,
      indexTtsModel: true,
      indexTtsCuda: false,
      alignment: true,
    },
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.errors.join("\n"), /CUDA/);

  const ready = inspectAudioReadiness(root, {
    capabilities: {
      indexTtsRuntime: true,
      indexTtsModel: true,
      indexTtsCuda: true,
      alignment: true,
    },
  });
  assert.equal(ready.ready, true, ready.errors.join("\n"));
  assert.equal(ready.wordTiming.mode, "alignment");
  assert.ok(ready.effectiveControls.includes("segment.delivery"));
});

test("默认真实音频执行会在调用外部引擎前阻止未就绪路线", () => {
  const root = project();
  compileProject(root);
  approve(root, "script");
  assert.throws(
    () => generateAudio(root, { readinessOptions: { capabilities: { heygenCredential: false } } }),
    /生产音频预检未通过/,
  );
});
