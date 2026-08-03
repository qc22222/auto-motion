import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  buildKokoroArgs,
  alignmentToWords,
  normalizeEngineLanguage,
  normalizeElevenLabsVoiceSettings,
  parseVolumeDetect,
  resolveKokoroInvocation,
  parseFfmpegDurationBanner,
  ffprobeDuration,
  synthesizeOne,
  synthesizeElevenLabs,
  synthesizeHeygen,
  synthResult,
} from "./tts.mjs";

test("FFmpeg 音量检测结果会识别正常声音与全静音", () => {
  assert.deepEqual(
    parseVolumeDetect("[Parsed_volumedetect_0] mean_volume: -21.4 dB\n[Parsed_volumedetect_0] max_volume: -1.8 dB"),
    { available: true, meanDb: -21.4, maxDb: -1.8, silent: false },
  );
  assert.deepEqual(
    parseVolumeDetect("mean_volume: -inf dB\nmax_volume: -inf dB"),
    { available: true, meanDb: -Infinity, maxDb: -Infinity, silent: true },
  );
});

test("ElevenLabs 字符级对齐会转换为适合中英文字幕的词元", () => {
  assert.deepEqual(
    alignmentToWords({
      characters: ["你", "好", " ", "A", "I"],
      character_start_times_seconds: [0, 0.2, 0.4, 0.45, 0.55],
      character_end_times_seconds: [0.2, 0.4, 0.45, 0.55, 0.7],
    }),
    [
      { text: "你", start: 0, end: 0.2 },
      { text: "好", start: 0.2, end: 0.4 },
      { text: "AI", start: 0.45, end: 0.7 },
    ],
  );
});

test("ElevenLabs 音色设置会映射语速和受支持参数", () => {
  assert.deepEqual(
    normalizeElevenLabsVoiceSettings({
      speed: 1.1,
      settings: { stability: 0.4, similarityBoost: 0.8, style: 0.2, useSpeakerBoost: false },
    }),
    {
      stability: 0.4,
      similarity_boost: 0.8,
      style: 0.2,
      use_speaker_boost: false,
      speed: 1.1,
    },
  );
});

test("ElevenLabs 使用官方带时间戳接口并直接返回字幕对齐", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-elevenlabs-native-"));
  const wavAbs = join(dir, "assets", "voice", "line-0.wav");
  let captured;
  try {
    const result = await synthesizeElevenLabs(
      {
        text: "你好 AI",
        voiceId: "authorized-voice",
        speed: 1.1,
        settings: { stability: 0.4 },
        pronunciations: { dictionaries: ["dictionary-id:version-id"] },
        wavAbs,
      },
      {
        env: { ELEVENLABS_API_KEY: "test-key" },
        fetch: async (url, options) => {
          captured = { url, options, body: JSON.parse(options.body) };
          return {
            ok: true,
            json: async () => ({
              audio_base64: Buffer.from("fake-audio").toString("base64"),
              alignment: {
                characters: ["你", "好", " ", "A", "I"],
                character_start_times_seconds: [0, 0.2, 0.4, 0.45, 0.55],
                character_end_times_seconds: [0.2, 0.4, 0.45, 0.55, 0.7],
              },
            }),
          };
        },
        transcodeToWav: (_bytes, path) => {
          writeFileSync(path, "RIFF");
          return true;
        },
      },
    );
    assert.equal(result.ok, true);
    assert.match(captured.url, /with-timestamps/);
    assert.equal(captured.options.headers["xi-api-key"], "test-key");
    assert.equal(captured.body.voice_settings.speed, 1.1);
    assert.deepEqual(captured.body.pronunciation_dictionary_locators, [
      { pronunciation_dictionary_id: "dictionary-id", version_id: "version-id" },
    ]);
    assert.deepEqual(result.words.at(-1), { text: "AI", start: 0.45, end: 0.7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ElevenLabs HTTP 失败即使没有响应正文读取器也会返回可诊断错误", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-elevenlabs-http-error-"));
  try {
    const result = await synthesizeElevenLabs(
      {
        text: "鉴权失败测试",
        voiceId: "unauthorized-voice",
        wavAbs: join(dir, "never-written.wav"),
      },
      {
        env: { ELEVENLABS_API_KEY: "bad-key" },
        fetch: async () => ({ ok: false, status: 401 }),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeEngineLanguage 把 BCP-47 中文语言码转换为本地引擎参数", () => {
  assert.equal(normalizeEngineLanguage("zh-CN", "kokoro"), "zh");
  assert.equal(normalizeEngineLanguage("zh_CN", "alignment"), "zh");
  assert.equal(normalizeEngineLanguage("en-US", "alignment"), "en");
  assert.equal(normalizeEngineLanguage("pt-BR", "kokoro"), "pt-br");
});

test("buildKokoroArgs 会传递语速并使用规范化语言码", () => {
  assert.deepEqual(
    buildKokoroArgs({
      textPath: "C:/tmp/line.txt",
      voiceId: "zf_xiaobei",
      lang: "zh-CN",
      speed: 1.15,
      wavRel: "assets/voice/line-001.wav",
    }),
    [
      "hyperframes",
      "tts",
      "C:/tmp/line.txt",
      "--voice",
      "zf_xiaobei",
      "--output",
      "assets/voice/line-001.wav",
      "--speed",
      "1.15",
      "--lang",
      "zh",
    ],
  );
});

test("Windows Kokoro 通过项目本地 HyperFrames 安全入口执行", () => {
  const launcher = "E:/workspace/exampleFolder/hyperframes-local.ps1";
  const result = resolveKokoroInvocation({
    args: ["hyperframes", "tts", "C:/tmp/line.txt", "--voice", "zf_xiaobei"],
    hyperframesDir: "E:/workspace/runs/demo",
    platform: "win32",
    workspaceLauncher: launcher,
    pathExists: (path) => path === launcher,
  });
  assert.equal(result.cmd, "powershell.exe");
  assert.deepEqual(result.args.slice(0, 5), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcher,
  ]);
  assert.deepEqual(result.args.slice(5), ["tts", "C:/tmp/line.txt", "--voice", "zf_xiaobei"]);
  assert.match(result.label, /hyperframes-local\.ps1/);
});

test("parseFfmpegDurationBanner reads ffmpeg's stderr Duration line", () => {
  const stderr = [
    "ffmpeg version 6.0",
    "Input #0, wav, from 'a.wav':",
    "  Duration: 00:00:03.42, bitrate: 705 kb/s",
    "At least one output file must be specified",
  ].join("\n");
  assert.equal(parseFfmpegDurationBanner(stderr), 3.42);
});

test("parseFfmpegDurationBanner handles an hours component", () => {
  const stderr = "  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s";
  assert.equal(parseFfmpegDurationBanner(stderr), 3723.5);
});

test("parseFfmpegDurationBanner returns NaN when there is no Duration line", () => {
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("ffmpeg: command not found")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner(undefined)));
});

// Regression for the actual bug: ffprobeDuration used to collapse "ffprobe
// binary is missing" (ENOENT — the "essentials"-style Windows ffmpeg build
// with no ffprobe.exe) and "file is genuinely unreadable" into the same NaN,
// giving audio.mjs no way to tell "measure differently" from "give up".
//
// Builds an isolated PATH containing only a fake `ffmpeg` stub (no `ffprobe`
// at all) so ffprobeDuration's spawnSync("ffprobe", ...) call ENOENTs for
// real, then verifies it recovers the duration via the ffmpeg fallback
// instead of returning NaN.
test("ffprobeDuration falls back to ffmpeg when the ffprobe binary itself is missing", () => {
  const calls = [];
  const fakeSpawnSync = (command) => {
    calls.push(command);
    if (command === "ffprobe") return { status: null, error: { code: "ENOENT" } };
    return {
      status: 1,
      stderr: "Duration: 00:00:02.50, start: 0.000000, bitrate: 128 kb/s",
    };
  };
  assert.equal(ffprobeDuration("/does/not/matter.wav", { spawnSync: fakeSpawnSync }), 2.5);
  assert.deepEqual(calls, ["ffprobe", "ffmpeg"]);
});

test("ffprobeDuration returns NaN when neither ffprobe nor ffmpeg resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-no-binaries-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // empty directory — nothing resolves
    assert.ok(Number.isNaN(ffprobeDuration("/does/not/matter.wav")));
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeOne(elevenlabs) creates the output dir before writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-el-mkdir-"));
  const wavAbs = join(dir, "assets", "voice", "line-0.wav"); // nested, not yet created
  const savedKey = process.env.ELEVENLABS_API_KEY;
  try {
    // Unset the key so the Python side fails fast — the mkdir must run before
    // the spawn regardless, which is what this guards.
    delete process.env.ELEVENLABS_API_KEY;
    await synthesizeOne({
      provider: "elevenlabs",
      text: "hi",
      voiceId: "v",
      wavAbs,
      hyperframesDir: dir,
    });
    assert.ok(existsSync(dirname(wavAbs)), "output directory should be created");
  } finally {
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeHeygen surfaces a thrown HTTP error (e.g. 402) instead of swallowing it", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => {
        throw new Error("HeyGen POST /voices/speech → HTTP 402\nplan_upgrade_required");
      },
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /402/);
  assert.match(res.error, /plan_upgrade_required/);
});

test("synthesizeHeygen surfaces a failed audio_url fetch with its status", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
      fetch: async () => ({ ok: false, status: 403 }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 403/);
});

test("synthesizeHeygen reports a missing audio_url", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    { heygenAuthHeaders: () => ({}), heygenJSON: async () => ({}) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no audio_url/);
});

test("synthesizeHeygen reports wav transcode failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-tts-test-"));
  try {
    const res = await synthesizeHeygen(
      { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: join(dir, "voice.wav") },
      {
        heygenAuthHeaders: () => ({}),
        heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
        transcodeToWav: () => false,
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "wav transcode failed (ffmpeg)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthResult names a non-zero subprocess exit", () => {
  const res = synthResult({ status: 2 }, "/tmp/none.wav", "kokoro (npx hyperframes tts)");
  assert.equal(res.ok, false);
  assert.match(res.error, /kokoro .* exited with status 2/);
});
