import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { assertAudioReady } from "./audio-readiness.mjs";
import { DEFAULT_AUDIO_ENGINE, DEFAULT_BGM_WAITER } from "./audio-paths.mjs";
import { compileProject } from "./compile.mjs";
import { PROJECT_FILES, SCHEMA_VERSION } from "./constants.mjs";
import {
  ensureDir,
  hashFiles,
  hashValue,
  nowIso,
  readJson,
  resolveInside,
  toPosix,
  writeJson,
  writeText,
} from "./fs-utils.mjs";
import { loadProjectModel, validateProjectModel } from "./model.mjs";
import { invalidateFrom, invalidateStages, setStage } from "./state.mjs";
import { estimateSpeech, round3 } from "./timing.mjs";

export function writeSilentWav(path, durationSeconds, sampleRate = 44_100) {
  const sampleCount = Math.max(1, Math.round(Math.max(0.01, durationSeconds) * sampleRate));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  ensureDir(dirname(path));
  writeFileSync(path, buffer);
  return round3(sampleCount / sampleRate);
}

function ffprobeDuration(path) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return null;
  const value = Number(String(result.stdout || "").trim());
  return Number.isFinite(value) ? round3(value) : null;
}

function escapeConcatPath(path) {
  return toPosix(resolve(path)).replaceAll("'", "'\\''");
}

function buildNarrationWithFfmpeg(projectRoot, model, voices, sceneDurations, totalDuration) {
  const tempRoot = join(projectRoot, ".harness", "audio-temp");
  ensureDir(tempRoot);
  const lines = [];
  const voicesByScene = new Map();
  for (const voice of voices) {
    const sceneVoices = voicesByScene.get(voice.sceneId) || [];
    sceneVoices.push(voice);
    voicesByScene.set(voice.sceneId, sceneVoices);
  }

  const appendSilence = (duration) => {
    const sampleCount = Math.max(1, Math.round(duration * 44_100));
    const silencePath = join(tempRoot, `silence-${sampleCount}-samples.wav`);
    if (!existsSync(silencePath)) writeSilentWav(silencePath, duration);
    lines.push(`file '${escapeConcatPath(silencePath)}'`);
    return round3(sampleCount / 44_100);
  };

  // 按 Storyboard 顺序组装旁白，并把场景停留与无旁白场景补成静音。
  // 这样真实 TTS 与模拟音频共享同一条完整时间轴，而不是只拼接说话片段。
  for (const scene of model.storyboard.scenes) {
    let emittedDuration = 0;
    for (const voice of voicesByScene.get(scene.id) || []) {
      lines.push(`file '${escapeConcatPath(join(projectRoot, voice.path))}'`);
      emittedDuration = round3(emittedDuration + voice.duration_s);
      if (voice.pause_after_s > 0) {
        emittedDuration = round3(emittedDuration + appendSilence(voice.pause_after_s));
      }
    }
    const targetDuration = round3(Number(sceneDurations[scene.id]) || 0);
    const remaining = round3(targetDuration - emittedDuration);
    if (remaining > 0.001) {
      appendSilence(remaining);
    } else if (remaining < -0.02) {
      throw new Error(
        `场景 ${scene.id} 的旁白时间轴超过场景时长：旁白 ${emittedDuration}s，场景 ${targetDuration}s`,
      );
    }
  }
  if (lines.length === 0) appendSilence(totalDuration);
  const listPath = join(tempRoot, "narration-concat.txt");
  writeText(listPath, lines.join("\n"));
  const outputPath = join(projectRoot, PROJECT_FILES.narration);
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ar",
      "44100",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`FFmpeg 拼接旁白失败：${String(result.stderr || result.stdout).trim()}`);
  }
  const duration = ffprobeDuration(outputPath);
  if (!duration || Math.abs(duration - totalDuration) > 0.15) {
    throw new Error(`旁白时长验证失败：期望 ${totalDuration}s，实际 ${duration ?? "未知"}s`);
  }
  return { path: PROJECT_FILES.narration, duration_s: duration };
}

function sceneAndFrameMaps(model) {
  const frameByScene = new Map(model.storyboard.scenes.map((scene) => [scene.id, scene.index]));
  const segmentById = new Map(model.script.segments.map((segment) => [segment.id, segment]));
  return { frameByScene, segmentById };
}

function normalizeWordTimings(segmentId, rawWords, duration) {
  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    throw new Error(`旁白 ${segmentId} 缺少字词时间戳，无法可靠生成字幕`);
  }
  let previousStart = -1;
  let hasPositiveSpan = false;
  return rawWords.map((word, index) => {
    const text = String(word?.text || "");
    const start = Number(word?.start);
    const end = Number(word?.end);
    if (!text.trim()) throw new Error(`旁白 ${segmentId} 的第 ${index + 1} 个字词时间戳缺少文字`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`旁白 ${segmentId} 的第 ${index + 1} 个字词时间戳不是有效数字`);
    }
    if (start < -0.001 || end < start || end > duration + 0.15) {
      throw new Error(
        `旁白 ${segmentId} 的第 ${index + 1} 个字词时间戳超出音频范围：${start}–${end}s / ${duration}s`,
      );
    }
    if (start < previousStart - 0.001) {
      throw new Error(`旁白 ${segmentId} 的字词时间戳顺序错误`);
    }
    previousStart = start;
    const normalizedStart = round3(Math.max(0, Math.min(duration, start)));
    const normalizedEnd = round3(Math.max(normalizedStart, Math.min(duration, end)));
    if (normalizedEnd > normalizedStart) hasPositiveSpan = true;
    return {
      id: String(word.id || `${segmentId}-w${index}`),
      text,
      start: normalizedStart,
      end: normalizedEnd,
    };
  }).map((word, index, words) => {
    if (index === words.length - 1 && !hasPositiveSpan) {
      throw new Error(`旁白 ${segmentId} 的字词时间戳没有有效时长`);
    }
    return word;
  });
}

function finalizeVoices(model, voiceItems) {
  const { frameByScene, segmentById } = sceneAndFrameMaps(model);
  const sceneOffsets = new Map();
  const voices = [];
  if (!Array.isArray(voiceItems)) throw new Error("音频引擎返回的 voices 必须是数组");
  const itemById = new Map();
  for (const item of voiceItems) {
    const itemId = String(item?.id || "");
    if (!segmentById.has(itemId)) throw new Error(`音频引擎返回未知旁白 id：${itemId || "<empty>"}`);
    if (itemById.has(itemId)) throw new Error(`音频引擎重复返回旁白 id：${itemId}`);
    itemById.set(itemId, item);
  }
  for (const segment of model.script.segments) {
    const item = itemById.get(segment.id);
    if (!item) throw new Error(`以下旁白没有生成音频：${segment.id}`);
    const pauseAfter = Math.max(0, Number(segment.pauseAfter) || 0);
    const reportedDuration = round3(Number(item.duration_s) || 0);
    if (reportedDuration <= 0) throw new Error(`旁白 ${segment.id} 的音频时长无效`);
    if (!String(item.path || "").trim()) throw new Error(`旁白 ${segment.id} 缺少音频文件路径`);
    const audioPath = resolveInside(model.root, String(item.path));
    if (!existsSync(audioPath)) throw new Error(`旁白 ${segment.id} 的音频文件不存在：${item.path}`);
    const duration = ffprobeDuration(audioPath);
    if (!duration || Math.abs(duration - reportedDuration) > 0.15) {
      throw new Error(
        `旁白 ${segment.id} 的音频时长与引擎元数据不一致：文件 ${duration ?? "未知"}s，元数据 ${reportedDuration}s`,
      );
    }
    const sceneOffset = round3(sceneOffsets.get(segment.sceneId) || 0);
    const words = normalizeWordTimings(segment.id, item.words, duration);
    const voice = {
      id: segment.id,
      segmentId: segment.id,
      sceneId: segment.sceneId,
      scene_id: segment.sceneId,
      frame: frameByScene.get(segment.sceneId),
      path: toPosix(relative(model.root, audioPath)),
      duration_s: duration,
      pause_after_s: pauseAfter,
      timeline_duration_s: round3(duration + pauseAfter),
      scene_offset_s: sceneOffset,
      words,
    };
    if (item.cache && typeof item.cache === "object") {
      voice.cache = {
        enabled: Boolean(item.cache.enabled),
        hit: Boolean(item.cache.hit),
        key: String(item.cache.key || ""),
      };
    }
    if (item.qc && typeof item.qc === "object") {
      voice.qc = {
        available: Boolean(item.qc.available),
        silent: Boolean(item.qc.silent),
        meanDb: Number.isFinite(Number(item.qc.meanDb)) ? Number(item.qc.meanDb) : null,
        maxDb: Number.isFinite(Number(item.qc.maxDb)) ? Number(item.qc.maxDb) : null,
      };
    }
    voices.push(voice);
    sceneOffsets.set(segment.sceneId, round3(sceneOffset + voice.timeline_duration_s));
  }
  return voices;
}

function createMeta(model, voices, options = {}) {
  const sceneDurations = {};
  for (const voice of voices) {
    sceneDurations[voice.sceneId] = round3(
      (sceneDurations[voice.sceneId] || 0) + voice.timeline_duration_s,
    );
  }
  for (const scene of model.storyboard.scenes) {
    if (!(scene.id in sceneDurations)) sceneDurations[scene.id] = Number(scene.duration) || 0;
    sceneDurations[scene.id] = round3(sceneDurations[scene.id] + (Number(scene.extraHold) || 0));
  }
  const totalDuration = round3(
    model.storyboard.scenes.reduce((sum, scene) => sum + (sceneDurations[scene.id] || 0), 0),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    mock: Boolean(options.mock),
    tts_provider: options.provider,
    voice_id: options.voiceId || model.voice.voiceId || (options.mock ? "mock-clone" : null),
    reference_audio: model.voice.provider === "indextts2" ? model.voice.referenceAudio : null,
    direction: model.voice.direction,
    voices,
    scene_durations: sceneDurations,
    total_duration_s: totalDuration,
    bgm: options.bgm || null,
    bgm_pending: Boolean(options.bgmPending),
    bgm_status: options.bgmStatus || null,
    tts_cache: options.ttsCache || null,
    anomalies: options.anomalies || [],
  };
}

function waitForPendingBgm(projectRoot, neutralPath, neutral, options = {}) {
  if (!neutral.bgm_pending) return neutral;
  const bgmPath = String(neutral.bgm?.path || "").trim();
  if (!bgmPath) throw new Error("音频引擎报告 bgm_pending，但没有提供背景音乐输出路径");
  const waiterPath = resolve(options.bgmWaiter || DEFAULT_BGM_WAITER);
  if (!existsSync(waiterPath)) throw new Error(`找不到项目本地 BGM 等待器：${waiterPath}`);
  const timeoutMs = Math.max(0, Number(options.bgmTimeoutMs ?? 120_000) || 0);
  const statusPath = join(projectRoot, ".harness", `bgm-status-${Date.now()}.json`);
  const result = spawnSync(
    process.execPath,
    [
      waiterPath,
      "--audio-meta",
      neutralPath,
      "--hyperframes",
      projectRoot,
      "--timeout-ms",
      String(timeoutMs),
      "--interval-ms",
      String(Math.max(250, Number(options.bgmIntervalMs) || 1000)),
      "--out",
      statusPath,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs + 15_000,
    },
  );
  writeText(join(projectRoot, ".harness", "logs", "bgm-wait.stdout.log"), result.stdout || "");
  writeText(join(projectRoot, ".harness", "logs", "bgm-wait.stderr.log"), result.stderr || "");
  if (result.error?.code === "ETIMEDOUT") throw new Error(`背景音乐等待进程超过 ${timeoutMs}ms 后仍未结束`);
  if (result.status !== 0) {
    throw new Error(`背景音乐等待器失败（退出码 ${result.status}）：${String(result.stderr || result.stdout).trim()}`);
  }
  if (!existsSync(statusPath)) throw new Error("背景音乐等待器没有写出状态文件");
  const status = readJson(statusPath);
  if (!status.ready || status.status !== "ready") {
    throw new Error(`背景音乐等待失败（${status.status || "unknown"}）：${status.message || "文件尚未就绪"}`);
  }
  const absoluteBgmPath = resolveInside(projectRoot, bgmPath);
  if (!existsSync(absoluteBgmPath)) throw new Error(`背景音乐状态为 ready，但文件不存在：${bgmPath}`);
  const duration = ffprobeDuration(absoluteBgmPath);
  if (!duration || duration <= 0) throw new Error(`背景音乐文件无法探测时长：${bgmPath}`);
  neutral.bgm = { ...neutral.bgm, path: toPosix(relative(projectRoot, absoluteBgmPath)), duration_s: duration };
  neutral.bgm_pending = false;
  neutral.bgm_status = status;
  writeJson(neutralPath, neutral);
  return neutral;
}

function generateMock(projectRoot, model) {
  const voiceItems = model.script.segments.map((segment) => {
    const timing = estimateSpeech(segment.text, {
      speed: model.voice.speed,
      language: model.voice.language,
    });
    const rel = `assets/voice/${segment.id}.wav`;
    const actualDuration = writeSilentWav(join(projectRoot, rel), timing.duration);
    return {
      id: segment.id,
      path: rel,
      duration_s: actualDuration,
      words: timing.words,
    };
  });
  const voices = finalizeVoices(model, voiceItems);
  const meta = createMeta(model, voices, { mock: true, provider: "mock" });
  meta.narration = {
    path: PROJECT_FILES.narration,
    duration_s: writeSilentWav(join(projectRoot, PROJECT_FILES.narration), meta.total_duration_s),
  };
  return meta;
}

function generateReal(projectRoot, model, options = {}) {
  const enginePath = resolve(options.engine || process.env.VIDEO_HARNESS_AUDIO_ENGINE || DEFAULT_AUDIO_ENGINE);
  if (!existsSync(enginePath)) throw new Error(`找不到项目本地音频引擎：${enginePath}`);
  const requestPath = join(projectRoot, PROJECT_FILES.audioRequest);
  const neutralPath = join(projectRoot, ".harness", "audio-engine-meta.json");
  const engineArgs = [
    enginePath,
    "--request",
    requestPath,
    "--hyperframes",
    projectRoot,
    "--out",
    neutralPath,
    "--only",
    options.only || "tts,bgm",
    "--provider",
    model.voice.provider,
    "--voice",
    model.voice.provider === "indextts2" ? model.voice.referenceAudio : model.voice.voiceId,
  ];
  if (options.forceTts) engineArgs.push("--force-tts");
  if (options.forceTtsLine) engineArgs.push("--force-tts-line", String(options.forceTtsLine));
  const result = spawnSync(
    process.execPath,
    engineArgs,
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  writeText(join(projectRoot, ".harness", "logs", "audio-engine.stdout.log"), result.stdout || "");
  writeText(join(projectRoot, ".harness", "logs", "audio-engine.stderr.log"), result.stderr || "");
  if (result.status !== 0) {
    throw new Error(`真实 TTS 执行失败（退出码 ${result.status}）：${String(result.stderr || result.stdout).trim()}`);
  }
  const neutral = waitForPendingBgm(projectRoot, neutralPath, readJson(neutralPath), options);
  const voices = finalizeVoices(model, neutral.voices || []);
  const meta = createMeta(model, voices, {
    mock: false,
    provider: neutral.tts_provider || model.voice.provider,
    voiceId: neutral.voice_id || null,
    bgm: neutral.bgm || null,
    bgmPending: neutral.bgm_pending,
    bgmStatus: neutral.bgm_status,
    ttsCache: neutral.tts_cache || null,
    anomalies: neutral.anomalies || [],
  });
  meta.narration = buildNarrationWithFfmpeg(
    projectRoot,
    model,
    voices,
    meta.scene_durations,
    meta.total_duration_s,
  );
  return meta;
}

export function selectAudioEngineScope({
  requestedScope,
  hasPreviousMeta,
  hasNeutralMeta,
  narrationChanged,
  bgmChanged,
}) {
  if (requestedScope) return requestedScope;
  if (!hasPreviousMeta || !hasNeutralMeta) return "tts,bgm";
  if (narrationChanged && !bgmChanged) return "tts";
  if (!narrationChanged && bgmChanged) return "bgm";
  return "tts,bgm";
}

export function generateAudio(projectRoot, options = {}) {
  compileProject(projectRoot);
  const model = loadProjectModel(projectRoot);
  if (options.forceTtsLine && !model.script.segments.some((segment) => segment.id === options.forceTtsLine)) {
    throw new Error(`找不到需要强制重生成的旁白段落：${options.forceTtsLine}`);
  }
  const requestedEngine = resolve(options.engine || process.env.VIDEO_HARNESS_AUDIO_ENGINE || DEFAULT_AUDIO_ENGINE);
  if (!options.mock && requestedEngine === resolve(DEFAULT_AUDIO_ENGINE) && !options.skipReadiness) {
    assertAudioReady(model.root, options.readinessOptions);
  }
  const validation = validateProjectModel(model, { mockAudio: Boolean(options.mock) });
  if (!validation.ok) throw new Error(`音频生成前校验失败：\n- ${validation.errors.join("\n- ")}`);
  const audioMetaPath = join(model.root, PROJECT_FILES.audioMeta);
  const previousMeta = existsSync(audioMetaPath) ? readJson(audioMetaPath) : null;
  const referenceAudioPaths = model.voice.provider === "indextts2"
    ? [model.voice.referenceAudio, model.voice.settings?.emotionMode === "audio" ? model.voice.settings?.emotionAudio : null]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  const narrationInputHash = hashValue({
    script: model.script,
    voice: model.voice,
    referenceAudioContentHash: referenceAudioPaths.length > 0
      ? hashFiles(model.root, referenceAudioPaths)
      : null,
  });
  const bgmInputHash = hashValue(model.project.audio?.bgm || { mode: "none" });
  const narrationChanged = Boolean(options.forceTts || options.forceTtsLine)
    || previousMeta?.narration_input_hash !== narrationInputHash;
  const bgmChanged = previousMeta?.bgm_input_hash !== bgmInputHash;
  const inputHash = hashValue({ narrationInputHash, bgmInputHash });
  if (narrationChanged || !previousMeta) invalidateFrom(model.root, "audio");
  else invalidateStages(model.root, ["audio", "delivery"]);
  setStage(model.root, "audio", "running", { inputHash });
  try {
    const scope = selectAudioEngineScope({
      requestedScope: options.only,
      hasPreviousMeta: Boolean(previousMeta),
      hasNeutralMeta: existsSync(join(model.root, ".harness", "audio-engine-meta.json")),
      narrationChanged,
      bgmChanged,
    });
    const meta = options.mock
      ? generateMock(model.root, model)
      : generateReal(model.root, model, { ...options, only: scope });
    const executed = new Set((options.mock ? "tts,bgm" : scope).split(","));
    meta.narration_input_hash = executed.has("tts")
      ? narrationInputHash
      : previousMeta?.narration_input_hash || null;
    meta.bgm_input_hash = executed.has("bgm")
      ? bgmInputHash
      : previousMeta?.bgm_input_hash || null;
    meta.engine_scope = options.mock ? "mock" : scope;
    writeJson(audioMetaPath, meta);
    const outputHash = hashValue(meta);
    const fullyUpdated = meta.narration_input_hash === narrationInputHash
      && meta.bgm_input_hash === bgmInputHash;
    setStage(model.root, "audio", fullyUpdated ? "complete" : "stale", { inputHash, outputHash });
    compileProject(model.root);
    return meta;
  } catch (error) {
    setStage(model.root, "audio", "failed", { inputHash, error: error.message });
    throw error;
  }
}

export function inspectWav(path) {
  return {
    path,
    exists: existsSync(path),
    duration: existsSync(path) ? ffprobeDuration(path) : null,
  };
}
