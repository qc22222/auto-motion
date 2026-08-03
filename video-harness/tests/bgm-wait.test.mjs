import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAudio } from "../lib/audio.mjs";
import { compileProject } from "../lib/compile.mjs";
import { readJson, writeJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { approve, loadState } from "../lib/state.mjs";

const WAV_WRITER = `
const writeWav = (path, duration) => {
  const rate = 44100, samples = Math.round(rate * duration), size = samples * 2;
  const b = Buffer.alloc(44 + size); b.write("RIFF", 0); b.writeUInt32LE(36 + size, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(size, 40); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, b);
};`;

function prepare() {
  const parent = mkdtempSync(join(tmpdir(), "harness-bgm-wait-"));
  const root = createProject(join(parent, "project"), { initialText: "等待背景音乐。" });
  const voice = readJson(join(root, "voice-profile.json"));
  voice.voiceId = "authorized-voice";
  writeJson(join(root, "voice-profile.json"), voice);
  compileProject(root);
  approve(root, "script");
  const engine = join(parent, "pending-engine.mjs");
  writeFileSync(
    engine,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2), flag = (name) => argv[argv.indexOf(name) + 1];
const request = JSON.parse(readFileSync(flag("--request"), "utf8"));
const root = flag("--hyperframes");
${WAV_WRITER}
const rel = "assets/voice/" + request.lines[0].id + ".wav"; writeWav(join(root, rel), 0.4);
writeFileSync(flag("--out"), JSON.stringify({
  tts_provider: "heygen", voice_id: request.voice,
  voices: [{ id: request.lines[0].id, path: rel, duration_s: 0.4, words: [{ id: "w0", text: request.lines[0].text, start: 0, end: 0.4 }] }],
  bgm_pending: true, bgm: { path: "assets/bgm/track.wav", volume: 0.12, mode: "generate" },
  bgm_provider: "musicgen", anomalies: []
}));`,
    "utf8",
  );
  return { parent, root, engine };
}

test("后台 BGM 完成后才允许音频阶段完成", { timeout: 60_000 }, () => {
  const { parent, root, engine } = prepare();
  const waiter = join(parent, "ready-waiter.mjs");
  writeFileSync(
    waiter,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2), flag = (name) => argv[argv.indexOf(name) + 1];
const meta = JSON.parse(readFileSync(flag("--audio-meta"), "utf8"));
${WAV_WRITER}
writeWav(join(flag("--hyperframes"), meta.bgm.path), 0.5);
writeFileSync(flag("--out"), JSON.stringify({ status: "ready", ready: true, path: meta.bgm.path, waited_ms: 5 }));`,
    "utf8",
  );
  const result = generateAudio(root, { engine, bgmWaiter: waiter, bgmTimeoutMs: 1000 });
  assert.equal(result.bgm_pending, false);
  assert.equal(result.bgm_status.status, "ready");
  assert.equal(existsSync(join(root, result.bgm.path)), true);
  assert.equal(loadState(root).stages.audio.status, "complete");
});

test("后台 BGM 超时会阻止音频阶段伪完成", { timeout: 60_000 }, () => {
  const { parent, root, engine } = prepare();
  const waiter = join(parent, "timeout-waiter.mjs");
  writeFileSync(
    waiter,
    `import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2), flag = (name) => argv[argv.indexOf(name) + 1];
writeFileSync(flag("--out"), JSON.stringify({ status: "timeout", ready: false, waited_ms: 10, message: "still running" }));`,
    "utf8",
  );
  assert.throws(
    () => generateAudio(root, { engine, bgmWaiter: waiter, bgmTimeoutMs: 10 }),
    /背景音乐.*timeout/,
  );
  assert.equal(loadState(root).stages.audio.status, "failed");
});
