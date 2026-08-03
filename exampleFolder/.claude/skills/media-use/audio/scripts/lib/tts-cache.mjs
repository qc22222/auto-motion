import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_CONTRACT = "media-use-tts-native-timing-v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function safeSegmentPrefix(segmentId) {
  const value = String(segmentId || "segment")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return value || "segment";
}

function cachePaths(cacheRoot, segmentId, key) {
  const base = `${safeSegmentPrefix(segmentId)}-${key}`;
  return {
    wavPath: join(cacheRoot, `${base}.wav`),
    metaPath: join(cacheRoot, `${base}.json`),
  };
}

export function buildTtsCacheKey({
  segmentId,
  provider,
  voiceId,
  lang,
  speed,
  text,
  settings = {},
  pronunciations = {},
  referenceAudioSha256,
  delivery,
}) {
  const payload = canonicalize({
    contract: CACHE_CONTRACT,
    segmentId: String(segmentId || ""),
    provider: String(provider || ""),
    voiceId: String(voiceId || ""),
    lang: String(lang || ""),
    speed: Number(speed),
    text: String(text || ""),
    settings,
    pronunciations,
    referenceAudioSha256,
    delivery,
  });
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex").slice(0, 24);
}

export function loadTtsCache({ cacheRoot, segmentId, key, durationProbe }) {
  const paths = cachePaths(cacheRoot, segmentId, key);
  if (!existsSync(paths.wavPath) || !existsSync(paths.metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(paths.metaPath, "utf8"));
    if (
      meta.schemaVersion !== CACHE_SCHEMA_VERSION
      || meta.key !== key
      || meta.segmentId !== String(segmentId)
      || !Array.isArray(meta.words)
      || meta.words.length === 0
    ) {
      return null;
    }
    const actualDuration = Number(durationProbe(paths.wavPath));
    const cachedDuration = Number(meta.duration_s);
    if (
      !Number.isFinite(actualDuration)
      || actualDuration <= 0
      || !Number.isFinite(cachedDuration)
      || Math.abs(actualDuration - cachedDuration) > 0.15
    ) {
      return null;
    }
    return {
      audioPath: paths.wavPath,
      duration_s: actualDuration,
      words: meta.words,
      cache: { enabled: true, hit: true, key },
    };
  } catch {
    return null;
  }
}

export function saveTtsCache({
  cacheRoot,
  segmentId,
  key,
  sourceWav,
  duration,
  words,
}) {
  const numericDuration = Number(duration);
  if (!Number.isFinite(numericDuration) || numericDuration <= 0) {
    throw new Error("不能缓存时长无效的 TTS 音频");
  }
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error("不能缓存缺少字词时间戳的 TTS 音频");
  }
  const paths = cachePaths(cacheRoot, segmentId, key);
  mkdirSync(cacheRoot, { recursive: true });
  copyFileSync(sourceWav, paths.wavPath);
  writeFileSync(
    paths.metaPath,
    `${JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      key,
      segmentId: String(segmentId),
      duration_s: numericDuration,
      words,
    }, null, 2)}\n`,
    "utf8",
  );
  return { audioPath: paths.wavPath, metaPath: paths.metaPath };
}

export function restoreTtsCache(entry, destination) {
  if (!entry?.audioPath || !existsSync(entry.audioPath)) {
    throw new Error("TTS 缓存音频不存在，无法恢复");
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(entry.audioPath, destination);
  return destination;
}
