import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTtsCacheKey,
  loadTtsCache,
  restoreTtsCache,
  saveTtsCache,
} from "./tts-cache.mjs";

test("TTS 缓存键与对象字段顺序无关，但会响应声音结果参数变化", () => {
  const base = {
    segmentId: "line-001",
    provider: "elevenlabs",
    voiceId: "voice-001",
    lang: "zh-CN",
    speed: 1.05,
    text: "缓存只应复用完全相同的声音请求。",
    settings: { stability: 0.4, similarityBoost: 0.8 },
    pronunciations: { dictionaries: ["dict:version"] },
  };
  assert.equal(
    buildTtsCacheKey(base),
    buildTtsCacheKey({
      ...base,
      settings: { similarityBoost: 0.8, stability: 0.4 },
    }),
  );
  assert.notEqual(buildTtsCacheKey(base), buildTtsCacheKey({ ...base, text: "文本已修改。" }));
  assert.notEqual(buildTtsCacheKey(base), buildTtsCacheKey({ ...base, speed: 1.1 }));
  assert.notEqual(
    buildTtsCacheKey(base),
    buildTtsCacheKey({ ...base, referenceAudioSha256: "changed-reference-audio" }),
  );
  assert.notEqual(
    buildTtsCacheKey(base),
    buildTtsCacheKey({ ...base, delivery: "更有力量地说" }),
  );
});

test("TTS 缓存会保存音频与时间戳、校验时长并恢复到交付路径", () => {
  const root = mkdtempSync(join(tmpdir(), "tts-cache-"));
  const source = join(root, "source.wav");
  const restored = join(root, "assets", "voice", "line-001.wav");
  writeFileSync(source, "RIFF-test-audio");
  try {
    const key = buildTtsCacheKey({
      segmentId: "line-001",
      provider: "elevenlabs",
      voiceId: "voice-001",
      lang: "zh-CN",
      speed: 1,
      text: "你好",
      settings: {},
      pronunciations: {},
    });
    saveTtsCache({
      cacheRoot: join(root, "cache"),
      segmentId: "line-001",
      key,
      sourceWav: source,
      duration: 0.8,
      words: [{ text: "你好", start: 0, end: 0.8 }],
    });
    const hit = loadTtsCache({
      cacheRoot: join(root, "cache"),
      segmentId: "line-001",
      key,
      durationProbe: () => 0.8,
    });
    assert.equal(hit.duration_s, 0.8);
    assert.equal(hit.words[0].text, "你好");
    restoreTtsCache(hit, restored);
    assert.equal(readFileSync(restored, "utf8"), "RIFF-test-audio");

    const rejected = loadTtsCache({
      cacheRoot: join(root, "cache"),
      segmentId: "line-001",
      key,
      durationProbe: () => 1.4,
    });
    assert.equal(rejected, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
