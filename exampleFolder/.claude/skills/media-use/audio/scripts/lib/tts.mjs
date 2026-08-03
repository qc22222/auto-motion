// tts.mjs — multi-provider TTS for the media audio engine. The provider chain,
// auto-detected from env, is the one documented in ../SKILL.md:
//
//   1. HeyGen (Starfish)  — $HEYGEN_API_KEY / $HYPERFRAMES_API_KEY / ~/.heygen.
//        Direct v3 REST (NOT `hyperframes tts`, which in the published build is
//        Kokoro-only and silently ignores a HeyGen key). Returns word_timestamps
//        in the same call, so no separate transcribe pass.
//   2. ElevenLabs         — $ELEVENLABS_API_KEY. Uses the official
//        /with-timestamps endpoint and consumes its character alignment directly.
//   3. Kokoro-82M (local) — always available, via the published `hyperframes tts`
//        CLI. No word timings → caller chains transcribeWav().
//
// "HeyGen available" is decided by CREDENTIAL presence (heygenCredential), never
// by the CLI — see the note above.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { heygenAuthHeaders, heygenCredential, heygenJSON } from "./heygen.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HYPERFRAMES_LAUNCHER = resolve(HERE, "../../../../../../hyperframes-local.ps1");
const DEFAULT_WORKSPACE_WHISPER = resolve(
  HERE,
  "../../../../../../../.codex/runtime/whisper/v1.8.6/whisper-cli.exe",
);
// HyperFrames 把 whisper 模型固定读取到 homedir()/.cache/hyperframes；whisper-cli
// 用 ANSI 编码打开模型路径，用户名含中文时必须把 USERPROFILE 重定向到 ASCII 家目录。
const ASCII_HYPERFRAMES_HOME = "E:/models/hyperframes-home";

// ── provider detection ────────────────────────────────────────────────────────
export function heygenAvailable() {
  return heygenCredential() !== null;
}
export function elevenlabsAvailable() {
  return Boolean(String(process.env.ELEVENLABS_API_KEY || "").trim());
}

// First available provider wins; an explicit choice is honored (and validated).
export function pickProvider(userProvider) {
  if (userProvider) {
    if (!["heygen", "elevenlabs", "kokoro", "indextts2"].includes(userProvider))
      throw new Error(`invalid provider "${userProvider}" (heygen | elevenlabs | kokoro | indextts2)`);
    if (userProvider === "heygen" && !heygenAvailable())
      throw new Error(
        "provider=heygen but no HeyGen credentials (set $HEYGEN_API_KEY or run `npx hyperframes auth login`)",
      );
    if (userProvider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY)
      throw new Error("provider=elevenlabs but $ELEVENLABS_API_KEY is not set");
    return userProvider;
  }
  return heygenAvailable() ? "heygen" : elevenlabsAvailable() ? "elevenlabs" : "kokoro";
}

// ── voice resolution ──────────────────────────────────────────────────────────
// HeyGen /v3/voices/speech only accepts STARFISH voice_ids; auto-pick the first
// English public starfish voice when none is pinned. ElevenLabs/Kokoro have
// their own defaults.
export async function resolveVoiceId({ provider, userVoice, lang = "en" }) {
  if (userVoice) return userVoice;
  const baseLanguage = normalizeEngineLanguage(lang, "alignment");
  if (provider === "elevenlabs") return "21m00Tcm4TlvDq8ikWAM"; // Rachel
  if (provider === "indextts2") {
    if (userVoice) return userVoice;
    throw new Error("IndexTTS2 needs an explicit project-local reference audio path");
  }
  if (provider === "kokoro") {
    if (baseLanguage === "en") return "am_michael";
    throw new Error("Kokoro non-English needs an explicit --voice (see references/tts.md)");
  }
  // heygen — pin a fixed English default so the choice is deterministic. The old
  // "first English voice the API returns" drifts whenever HeyGen re-sorts the
  // public catalog. Marcia (mature, low female). Override with --voice / request.voice.
  if (baseLanguage === "en") return "05f19352e8f74b0392a8f411eba40de1"; // Marcia · English · female
  throw new Error(`HeyGen ${lang} needs an explicit starfish --voice`);
}

// ── helpers ─────────────────────────────────────────────────────────────────
export function withWordIds(words) {
  return (words ?? []).map((w, i) => ({
    id: `w${i}`,
    text: w.text,
    start: w.start,
    end: w.end,
  }));
}

export function normalizeEngineLanguage(language = "en", target = "alignment") {
  const value = String(language || "en").trim().toLowerCase().replaceAll("_", "-");
  const base = value.split("-")[0];
  if (target === "kokoro") {
    if (value === "en-gb" || value.startsWith("en-gb-")) return "en-gb";
    if (base === "en") return "en-us";
    if (base === "zh") return "zh";
    if (base === "fr") return "fr-fr";
    if (base === "pt") return "pt-br";
    return ["es", "hi", "it", "ja"].includes(base) ? base : value;
  }
  return base || "en";
}

export function buildKokoroArgs({ textPath, voiceId, lang, speed, wavRel }) {
  const args = [
    "hyperframes",
    "tts",
    textPath,
    "--voice",
    voiceId,
    "--output",
    wavRel,
    "--speed",
    String(speed),
  ];
  const normalizedLanguage = normalizeEngineLanguage(lang, "kokoro");
  if (normalizedLanguage) args.push("--lang", normalizedLanguage);
  return args;
}

export function resolveHyperframesInvocation({
  args,
  hyperframesDir,
  platform = process.platform,
  workspaceLauncher = DEFAULT_HYPERFRAMES_LAUNCHER,
  pathExists = existsSync,
  label = "HyperFrames 命令",
}) {
  if (platform !== "win32") {
    return { cmd: "npx", args, label };
  }
  const projectLauncher = join(hyperframesDir, "hyperframes-local.ps1");
  const launcher = pathExists(projectLauncher)
    ? projectLauncher
    : pathExists(workspaceLauncher)
      ? workspaceLauncher
      : null;
  if (!launcher) {
    throw new Error("Windows Kokoro 找不到 hyperframes-local.ps1 项目本地安全入口");
  }
  if (args[0] !== "hyperframes") throw new Error("Kokoro HyperFrames 参数缺少命令前缀");
  return {
    cmd: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, ...args.slice(1)],
    label,
  };
}

export function resolveKokoroInvocation(options) {
  return resolveHyperframesInvocation({
    ...options,
    label: "kokoro (hyperframes-local.ps1 tts)",
  });
}

export function alignmentToWords(alignment) {
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) {
    throw new Error("ElevenLabs response has no character alignment");
  }
  if (characters.length === 0 || starts.length !== characters.length || ends.length !== characters.length) {
    throw new Error("ElevenLabs character alignment arrays have inconsistent lengths");
  }
  const words = [];
  let latin = null;
  const flushLatin = () => {
    if (latin) words.push(latin);
    latin = null;
  };
  const isLatinWord = (value) => /[\p{Script=Latin}\p{Number}'’_-]/u.test(value);
  for (let index = 0; index < characters.length; index++) {
    const text = String(characters[index] ?? "");
    const start = Number(starts[index]);
    const end = Number(ends[index]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error(`ElevenLabs character alignment item ${index + 1} is invalid`);
    }
    if (/^\s+$/u.test(text)) {
      flushLatin();
      continue;
    }
    if (isLatinWord(text)) {
      if (latin) {
        latin.text += text;
        latin.end = end;
      } else {
        latin = { text, start, end };
      }
      continue;
    }
    flushLatin();
    if (text) words.push({ text, start, end });
  }
  flushLatin();
  if (words.length === 0) throw new Error("ElevenLabs character alignment contains no usable text");
  return words;
}

function boundedNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
}

export function normalizeElevenLabsVoiceSettings({ speed = 1, settings = {} } = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const allowed = new Set([
    "stability",
    "similarityBoost",
    "similarity_boost",
    "style",
    "useSpeakerBoost",
    "use_speaker_boost",
  ]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unsupported ElevenLabs voice settings: ${unknown.join(", ")}`);
  const normalized = {};
  if (source.stability != null) normalized.stability = boundedNumber(source.stability, "stability", 0, 1);
  const similarity = source.similarityBoost ?? source.similarity_boost;
  if (similarity != null) normalized.similarity_boost = boundedNumber(similarity, "similarity_boost", 0, 1);
  if (source.style != null) normalized.style = boundedNumber(source.style, "style", 0, 1);
  const speakerBoost = source.useSpeakerBoost ?? source.use_speaker_boost;
  if (speakerBoost != null) {
    if (typeof speakerBoost !== "boolean") throw new Error("use_speaker_boost must be boolean");
    normalized.use_speaker_boost = speakerBoost;
  }
  normalized.speed = boundedNumber(speed, "ElevenLabs speed", 0.7, 1.2);
  return normalized;
}

export function normalizeElevenLabsPronunciationLocators(pronunciations = {}) {
  const entries = Array.isArray(pronunciations?.dictionaries) ? pronunciations.dictionaries : [];
  return entries.map((entry, index) => {
    if (typeof entry === "string") {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(`pronunciation dictionary ${index + 1} must use dictionaryId:versionId`);
      }
      return {
        pronunciation_dictionary_id: entry.slice(0, separator).trim(),
        version_id: entry.slice(separator + 1).trim(),
      };
    }
    const dictionaryId = entry?.id ?? entry?.pronunciation_dictionary_id;
    const versionId = entry?.versionId ?? entry?.version_id;
    if (!String(dictionaryId || "").trim() || !String(versionId || "").trim()) {
      throw new Error(`pronunciation dictionary ${index + 1} is missing id or versionId`);
    }
    return { pronunciation_dictionary_id: String(dictionaryId), version_id: String(versionId) };
  });
}

// `ffmpeg -i <file>` prints a `Duration: HH:MM:SS.ms` line to stderr even
// though it exits non-zero with no output requested. Parsing pulled out as
// a pure function so the ENOENT fallback below can be tested without
// depending on whether ffprobe/ffmpeg are actually installed on the
// machine running the tests.
export function parseFfmpegDurationBanner(stderrText) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrText ?? "");
  if (!match) return NaN;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// Some "essentials"-style ffmpeg distributions (common on Windows) ship
// ffmpeg.exe without ffprobe.exe. ffprobeDuration's caller (audio.mjs)
// otherwise reads a spurious NaN as "the WAV file is corrupt" and drops an
// already-successfully-synthesized TTS line, rather than "the tool for
// measuring it is missing".
function ffmpegDurationFallback(absPath, run = spawnSync) {
  const r = run("ffmpeg", ["-i", absPath], { encoding: "utf8" });
  return parseFfmpegDurationBanner(r.stderr);
}

export function ffprobeDuration(absPath, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const r = run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", absPath],
    { encoding: "utf8" },
  );
  if (r.error?.code === "ENOENT") return ffmpegDurationFallback(absPath, run);
  if (r.status !== 0) return NaN;
  return parseFloat(String(r.stdout).trim());
}

function parseVolumeDb(value) {
  if (String(value).toLowerCase() === "-inf") return -Infinity;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseVolumeDetect(stderrText) {
  const text = String(stderrText || "");
  const meanMatch = /mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/iu.exec(text);
  const maxMatch = /max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/iu.exec(text);
  if (!meanMatch || !maxMatch) {
    return { available: false, meanDb: null, maxDb: null, silent: false };
  }
  const meanDb = parseVolumeDb(meanMatch[1]);
  const maxDb = parseVolumeDb(maxMatch[1]);
  return {
    available: true,
    meanDb,
    maxDb,
    silent: maxDb === -Infinity || (Number.isFinite(maxDb) && maxDb <= -50),
  };
}

export function inspectWavSignal(absPath) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", absPath, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error?.code === "ENOENT") {
    return { available: false, meanDb: null, maxDb: null, silent: false };
  }
  return parseVolumeDetect(result.stderr);
}

export function resolveNpxCliFromNpmExecPath(
  npmExecPath = process.env.npm_execpath,
  pathExists = existsSync,
) {
  if (!npmExecPath) return null;
  const normalizedPath = String(npmExecPath).replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop()?.toLowerCase();
  const npxCliPath =
    fileName === "npx-cli.js"
      ? normalizedPath
      : `${normalizedPath.slice(0, normalizedPath.lastIndexOf("/"))}/npx-cli.js`;
  return pathExists(npxCliPath) ? npxCliPath : null;
}

export function resolveNpxCliPath(
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.env.npm_node_execpath || process.execPath,
  pathExists = existsSync,
) {
  const fromNpm = resolveNpxCliFromNpmExecPath(npmExecPath, pathExists);
  if (fromNpm) return fromNpm;
  const normalizedNode = String(nodeExecPath).replace(/\\/g, "/");
  const besideNode = `${normalizedNode.slice(0, normalizedNode.lastIndexOf("/"))}/node_modules/npm/bin/npx-cli.js`;
  return pathExists(besideNode) ? besideNode : null;
}

export function resolveSpawnCommand(
  cmd,
  args,
  opts = {},
  platform = process.platform,
  env = process.env,
  pathExists = existsSync,
) {
  if (cmd !== "npx" || platform !== "win32") {
    return { cmd, args, opts: { stdio: "ignore", ...opts } };
  }

  // On Windows, npx resolves to npx.cmd, which Node cannot execute directly.
  // Avoid `shell:true` and the .cmd shim entirely by invoking npm's JS CLI with
  // node, preserving request-provided values as argv data instead of shell text.
  const nodeExecPath = env.npm_node_execpath || process.execPath;
  const npxCliPath = resolveNpxCliPath(env.npm_execpath, nodeExecPath, pathExists);
  if (!npxCliPath) return null;
  return {
    cmd: nodeExecPath,
    args: [npxCliPath, ...args.map((arg) => String(arg))],
    opts: { stdio: "ignore", windowsHide: true, ...opts },
  };
}

// `platform`/`spawnFn` params (default process.platform / the real spawn)
// exist so tests can exercise the win32 branch without mocking node:child_process
// (its ESM exports are non-configurable, so mock.method can't patch it).
// One-shot so a whole batch of TTS lines doesn't repeat the same diagnostic.
let _warnedNpxResolution = false;
/** Test-only: reset the one-shot npx-resolution warning latch. */
export function _resetNpxResolutionWarnForTests() {
  _warnedNpxResolution = false;
}

export function spawnP(
  cmd,
  args,
  opts = {},
  platform = process.platform,
  spawnFn = spawn,
  env = process.env,
  pathExists = existsSync,
) {
  const resolved = resolveSpawnCommand(cmd, args, opts, platform, env, pathExists);
  if (!resolved) {
    // resolveSpawnCommand only returns null for the npx-on-win32 case where
    // neither npm's configured CLI nor the beside-node fallback exists. Without
    // this, every call silently returns status:-1 and stdio:"ignore" hides why.
    if (!_warnedNpxResolution) {
      _warnedNpxResolution = true;
      const reason = env.npm_execpath
        ? `npm_execpath (${env.npm_execpath}) and the beside-node npm fallback could not be found`
        : "npm_execpath is unset and the beside-node npm fallback could not be found";
      console.error(
        `[media-use] Cannot run "${cmd}" on Windows: ${reason}. ` +
          `Every "${cmd}" call is being skipped. Install npm with Node, or run via ` +
          `\`npx\`/\`npm run\` with a valid npm_execpath.`,
      );
    }
    return Promise.resolve({ status: -1 });
  }
  return new Promise((resolve) => {
    const p = spawnFn(resolved.cmd, resolved.args, resolved.opts);
    p.on("exit", (code) => resolve({ status: code ?? -1 }));
    p.on("error", () => resolve({ status: -1 }));
  });
}

// mp3/whatever bytes → wav 44.1k mono at destWav (ffmpeg detects true format).
function transcodeToWav(bytes, destWav) {
  const td = mkdtempSync(join(tmpdir(), "hf-tts-"));
  const tmp = join(td, "a.mp3");
  writeFileSync(tmp, bytes);
  mkdirSync(dirname(destWav), { recursive: true });
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", tmp, "-ar", "44100", "-ac", "1", destWav],
    { stdio: "ignore" },
  );
  rmSync(td, { recursive: true, force: true });
  return ff.status === 0 && existsSync(destWav);
}

export async function synthesizeElevenLabs(
  { text, voiceId, speed = 1, settings = {}, pronunciations = {}, wavAbs },
  deps = {},
) {
  try {
    mkdirSync(dirname(wavAbs), { recursive: true });
    const env = deps.env ?? process.env;
    const apiKey = String(env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) return { ok: false, words: null, error: "ELEVENLABS_API_KEY is not set" };
    const voiceSettings = normalizeElevenLabsVoiceSettings({ speed, settings });
    const locators = normalizeElevenLabsPronunciationLocators(pronunciations);
    const body = {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: voiceSettings,
    };
    if (locators.length > 0) body.pronunciation_dictionary_locators = locators;
    const fetchImpl = deps.fetch ?? fetch;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128&enable_logging=false`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = typeof response.text === "function"
        ? await response.text().catch(() => "")
        : "";
      return {
        ok: false,
        words: null,
        error: `ElevenLabs with-timestamps returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      };
    }
    const payload = await response.json();
    if (!payload.audio_base64) {
      return { ok: false, words: null, error: "ElevenLabs with-timestamps returned no audio_base64" };
    }
    const bytes = Buffer.from(payload.audio_base64, "base64");
    const transcode = deps.transcodeToWav ?? transcodeToWav;
    if (!transcode(bytes, wavAbs)) {
      return { ok: false, words: null, error: "ElevenLabs audio transcode failed (ffmpeg)" };
    }
    const words = alignmentToWords(payload.alignment ?? payload.normalized_alignment);
    return { ok: true, words };
  } catch (error) {
    return { ok: false, words: null, error: error?.message ? String(error.message) : String(error) };
  }
}

// ── synthesize one line ───────────────────────────────────────────────────────
// Writes wav at wavAbs. Returns { ok, words, error } — words is the raw
// [{text,start,end}] array for HeyGen/ElevenLabs（原生），Kokoro 返回 null，
// 由调用方执行字词对齐。Never throws; failures return { ok:false, error }
// where `error` states WHY (so the caller can surface it, not a bare "TTS failed").
export async function synthesizeOne({
  provider,
  text,
  voiceId,
  lang = "en",
  speed = 1.0,
  wavAbs,
  hyperframesDir,
  settings = {},
  pronunciations = {},
}, deps = {}) {
  if (provider === "heygen") return synthesizeHeygen({ text, voiceId, lang, speed, wavAbs }, deps);
  if (provider === "elevenlabs") {
    return synthesizeElevenLabs({ text, voiceId, speed, settings, pronunciations, wavAbs }, deps);
  }
  // kokoro — via the published CLI; --output is relative to the project dir.
  const wavRel = relTo(hyperframesDir, wavAbs);
  const args = buildKokoroArgs({
    textPath: writeTmpText(text),
    voiceId,
    lang,
    speed,
    wavRel,
  });
  let invocation;
  try {
    invocation = resolveKokoroInvocation({
      args,
      hyperframesDir,
      platform: deps.platform,
      workspaceLauncher: deps.workspaceLauncher,
      pathExists: deps.pathExists,
    });
  } catch (error) {
    return { ok: false, words: null, error: error.message };
  }
  const spawn = deps.spawnP ?? spawnP;
  const r = await spawn(invocation.cmd, invocation.args, { cwd: hyperframesDir });
  return synthResult(r, wavAbs, invocation.label);
}

// Shape a spawn result into { ok, words, error }, naming why on failure so the
// caller surfaces it instead of a bare "TTS failed".
export function synthResult(r, wavAbs, label) {
  if (r.status === 0 && existsSync(wavAbs)) return { ok: true, words: null };
  const why =
    r.status !== 0 ? `${label} exited with status ${r.status}` : `${label} produced no wav file`;
  return { ok: false, words: null, error: why };
}

// `deps` is injectable for tests; production uses the real network/ffmpeg impls.
// Every failure path returns an `error` string so the caller can surface WHY a
// line was dropped instead of the bare "TTS failed" that hid the real cause
// (e.g. an HTTP 402 plan_upgrade_required thrown by heygenJSON was swallowed).
export async function synthesizeHeygen({ text, voiceId, lang, speed, wavAbs }, deps = {}) {
  const requestJSON = deps.heygenJSON ?? heygenJSON;
  const authHeaders = deps.heygenAuthHeaders ?? heygenAuthHeaders;
  const fetchImpl = deps.fetch ?? fetch;
  const transcode = deps.transcodeToWav ?? transcodeToWav;
  try {
    const body = { text, voice_id: voiceId, speed };
    if (lang !== "en") body.language = lang;
    const payload = await requestJSON(`/voices/speech`, {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const inner = payload.data ?? payload;
    if (!inner.audio_url) {
      return { ok: false, words: null, error: "HeyGen /voices/speech returned no audio_url" };
    }
    const res = await fetchImpl(inner.audio_url);
    if (!res.ok) {
      return { ok: false, words: null, error: `audio_url fetch failed: HTTP ${res.status}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // .wav output → transcode to 44.1k mono; .mp3 → raw bytes (no ffmpeg). The
    // engine always asks for .wav; the standalone heygen-tts CLI may ask for .mp3.
    if (wavAbs.endsWith(".wav")) {
      if (!transcode(bytes, wavAbs)) {
        return {
          ok: false,
          words: null,
          error: "wav transcode failed (ffmpeg)",
        };
      }
    } else {
      mkdirSync(dirname(wavAbs), { recursive: true });
      writeFileSync(wavAbs, bytes);
    }
    const words = Array.isArray(inner.word_timestamps)
      ? inner.word_timestamps
          .filter((w) => w && typeof w.word === "string" && isFinite(w.start) && isFinite(w.end))
          .filter((w) => !/^<.*>$/.test(w.word.trim())) // drop <start>/<end> sentinels
          .map((w) => ({ text: w.word, start: w.start, end: w.end }))
      : [];
    return { ok: true, words };
  } catch (e) {
    return { ok: false, words: null, error: e?.message ? String(e.message) : String(e) };
  }
}

// Kokoro has no word timings — run Whisper over the wav. Returns the
// flat [{id,text,start,end}] word array, or null. Each call uses a throwaway
// --dir so parallel scenes don't collide on transcript.json.
export async function transcribeWav({ wavRel, lang = "en", hyperframesDir }) {
  const alignmentLanguage = normalizeEngineLanguage(lang, "alignment");
  const model = alignmentLanguage === "en" ? "small.en" : "small";
  const td = mkdtempSync(join(tmpdir(), "hf-trans-"));
  const args = ["hyperframes", "transcribe", wavRel, "--model", model, "--dir", td];
  if (alignmentLanguage !== "en") args.push("--language", alignmentLanguage);
  let invocation;
  try {
    invocation = resolveHyperframesInvocation({
      args,
      hyperframesDir,
      label: "word alignment (hyperframes-local.ps1 transcribe)",
    });
  } catch {
    rmSync(td, { recursive: true, force: true });
    return null;
  }
  const alignmentEnv = { ...process.env };
  if (!alignmentEnv.HYPERFRAMES_WHISPER_PATH && existsSync(DEFAULT_WORKSPACE_WHISPER)) {
    alignmentEnv.HYPERFRAMES_WHISPER_PATH = DEFAULT_WORKSPACE_WHISPER;
  }
  if (
    process.platform === "win32"
    && /[^\x00-\x7F]/.test(alignmentEnv.USERPROFILE || "")
    && existsSync(ASCII_HYPERFRAMES_HOME)
  ) {
    alignmentEnv.USERPROFILE = ASCII_HYPERFRAMES_HOME;
  }
  const r = await spawnP(invocation.cmd, invocation.args, { cwd: hyperframesDir, env: alignmentEnv });
  let words = null;
  if (r.status === 0) {
    const src = join(td, "transcript.json");
    if (existsSync(src)) {
      try {
        const arr = JSON.parse(readFileSync(src, "utf8"));
        if (Array.isArray(arr) && arr.length) words = arr;
      } catch {}
    }
  }
  rmSync(td, { recursive: true, force: true });
  return words;
}

// ── tiny local utils ──────────────────────────────────────────────────────────
function writeTmpText(text) {
  const td = mkdtempSync(join(tmpdir(), "hf-txt-"));
  const p = join(td, "line.txt");
  writeFileSync(p, text);
  return p;
}
function relTo(base, abs) {
  return abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
}
