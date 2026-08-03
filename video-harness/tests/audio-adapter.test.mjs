import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAudio, selectAudioEngineScope } from "../lib/audio.mjs";
import { compileProject } from "../lib/compile.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { approve } from "../lib/state.mjs";

test("音频执行范围会按旁白与 BGM 的独立变化精确选择", () => {
  const base = { hasPreviousMeta: true, hasNeutralMeta: true };
  assert.equal(selectAudioEngineScope({ ...base, narrationChanged: true, bgmChanged: false }), "tts");
  assert.equal(selectAudioEngineScope({ ...base, narrationChanged: false, bgmChanged: true }), "bgm");
  assert.equal(selectAudioEngineScope({ ...base, narrationChanged: true, bgmChanged: true }), "tts,bgm");
  assert.equal(selectAudioEngineScope({ ...base, hasNeutralMeta: false, narrationChanged: true, bgmChanged: false }), "tts,bgm");
});

test("IndexTTS2 参考音频内容变化会使旁白输入哈希失效", () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "harness-index-reference-hash-")), "project"), {
    initialText: "参考音频内容寻址测试。",
  });
  const referencePath = join(root, "assets", "reference", "owner.wav");
  writeFileSync(referencePath, "first-authorized-reference");
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "indextts2";
  voice.voiceId = "";
  voice.cloneRequired = true;
  voice.referenceAudio = "assets/reference/owner.wav";
  voice.referenceAudioAuthorized = true;
  voice.settings = { emotionMode: "delivery", emotionWeight: 0.6 };
  writeJson(join(root, "voice-profile.json"), voice);
  const first = generateAudio(root, { mock: true });
  writeFileSync(referencePath, "second-authorized-reference");
  const second = generateAudio(root, { mock: true });
  assert.notEqual(first.narration_input_hash, second.narration_input_hash);
});

test("真实音频适配层可消费项目内引擎的字词时间戳", { timeout: 60_000 }, () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-real-adapter-"));
  const root = createProject(join(parent, "project"), { initialText: "真实适配层测试。" });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "heygen";
  voice.voiceId = "clone-voice-001";
  writeJson(join(root, "voice-profile.json"), voice);
  compileProject(root);
  approve(root, "script");

  const engine = join(parent, "stub-audio-engine.mjs");
  writeFileSync(
    engine,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const request = JSON.parse(readFileSync(flag("--request"), "utf8"));
const root = flag("--hyperframes");
const writeWav = (path, duration) => {
  const rate = 44100, samples = Math.round(rate * duration), size = samples * 2;
  const b = Buffer.alloc(44 + size); b.write("RIFF", 0); b.writeUInt32LE(36 + size, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(size, 40); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, b);
};
const voices = request.lines.map((line) => { const rel = "assets/voice/" + line.id + ".wav"; writeWav(join(root, rel), 0.4); return { id: line.id, path: rel, duration_s: 0.4, words: [{ id: "w0", text: line.text, start: 0, end: 0.4 }], cache: { enabled: true, hit: true, key: "cache-key" } }; });
writeFileSync(flag("--out"), JSON.stringify({ tts_provider: "heygen", voice_id: request.voice, voices, bgm: null, tts_cache: { enabled: true, hits: 1, misses: 0 }, anomalies: [] }));
`,
    "utf8",
  );
  const result = generateAudio(root, { engine });
  assert.equal(result.mock, false);
  assert.equal(result.tts_provider, "heygen");
  assert.equal(result.voice_id, "clone-voice-001");
  assert.equal(result.voices[0].sceneId, "scene-001");
  assert.equal(result.voices[0].words[0].text, "真实适配层测试。");
  assert.equal(result.voices[0].cache.hit, true);
  assert.equal(result.tts_cache.hits, 1);
  assert.equal(existsSync(join(root, result.narration.path)), true);
});

test("强制重生成单段旁白只把目标段作为缓存旁路参数传给音频引擎", { timeout: 60_000 }, () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-force-one-line-"));
  const root = createProject(join(parent, "project"), { initialText: "只重做这一段。" });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.voiceId = "clone-voice-001";
  writeJson(join(root, "voice-profile.json"), voice);
  compileProject(root);
  approve(root, "script");
  const engine = join(parent, "capture-force-engine.mjs");
  writeFileSync(
    engine,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2), flag = (name) => argv[argv.indexOf(name) + 1];
const request = JSON.parse(readFileSync(flag("--request"), "utf8")), root = flag("--hyperframes");
const line = request.lines[0], rel = "assets/voice/" + line.id + ".wav", path = join(root, rel);
const rate = 44100, samples = Math.round(rate * 0.4), size = samples * 2, b = Buffer.alloc(44 + size);
b.write("RIFF", 0); b.writeUInt32LE(36 + size, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(size, 40); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, b);
writeFileSync(join(root, ".harness", "captured-args.json"), JSON.stringify(argv));
writeFileSync(flag("--out"), JSON.stringify({ tts_provider: "heygen", voice_id: request.voice, voices: [{ id: line.id, path: rel, duration_s: 0.4, words: [{ text: line.text, start: 0, end: 0.4 }] }], bgm: null, anomalies: [] }));
`,
    "utf8",
  );
  generateAudio(root, { engine, forceTtsLine: "line-001" });
  const args = readJson(join(root, ".harness", "captured-args.json"));
  assert.deepEqual(args.slice(args.indexOf("--force-tts-line"), args.indexOf("--force-tts-line") + 2), ["--force-tts-line", "line-001"]);
});

test("真实旁白会补齐场景停留时间并与 Storyboard 总时长一致", { timeout: 60_000 }, () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-real-hold-"));
  const root = createProject(join(parent, "project"), { initialText: "停留时间测试。" });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "heygen";
  voice.voiceId = "clone-voice-001";
  writeJson(join(root, "voice-profile.json"), voice);
  const storyboard = readJson(join(root, "storyboard.json"));
  storyboard.scenes[0].extraHold = 0.4;
  writeJson(join(root, "storyboard.json"), storyboard);
  compileProject(root);
  approve(root, "script");

  const engine = join(parent, "stub-audio-engine.mjs");
  writeFileSync(
    engine,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const request = JSON.parse(readFileSync(flag("--request"), "utf8"));
const root = flag("--hyperframes");
const writeWav = (path, duration) => {
  const rate = 44100, samples = Math.round(rate * duration), size = samples * 2;
  const b = Buffer.alloc(44 + size); b.write("RIFF", 0); b.writeUInt32LE(36 + size, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(size, 40); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, b);
};
const voices = request.lines.map((line) => { const rel = "assets/voice/" + line.id + ".wav"; writeWav(join(root, rel), 0.4); return { id: line.id, path: rel, duration_s: 0.4, words: [{ id: "w0", text: line.text, start: 0, end: 0.4 }] }; });
writeFileSync(flag("--out"), JSON.stringify({ tts_provider: "heygen", voice_id: request.voice, voices, bgm: null, anomalies: [] }));
`,
    "utf8",
  );

  const result = generateAudio(root, { engine });
  assert.equal(result.scene_durations["scene-001"], 1.05);
  assert.equal(result.total_duration_s, 1.05);
  assert.ok(Math.abs(result.narration.duration_s - result.total_duration_s) <= 0.01);
});

test("真实音频缺少字词时间戳时必须失败，不能生成空字幕", { timeout: 60_000 }, () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-real-no-words-"));
  const root = createProject(join(parent, "project"), { initialText: "时间戳不能为空。" });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.provider = "heygen";
  voice.voiceId = "clone-voice-001";
  writeJson(join(root, "voice-profile.json"), voice);
  compileProject(root);
  approve(root, "script");

  const engine = join(parent, "stub-audio-engine.mjs");
  writeFileSync(
    engine,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const request = JSON.parse(readFileSync(flag("--request"), "utf8"));
const root = flag("--hyperframes");
const rel = "assets/voice/" + request.lines[0].id + ".wav";
const rate = 44100, samples = Math.round(rate * 0.4), size = samples * 2;
const b = Buffer.alloc(44 + size); b.write("RIFF", 0); b.writeUInt32LE(36 + size, 4); b.write("WAVE", 8);
b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
b.write("data", 36); b.writeUInt32LE(size, 40); mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), b);
writeFileSync(flag("--out"), JSON.stringify({ tts_provider: "heygen", voices: [{ id: request.lines[0].id, path: rel, duration_s: 0.4, words: [] }] }));
`,
    "utf8",
  );

  assert.throws(() => generateAudio(root, { engine }), /字词时间戳/);
});
