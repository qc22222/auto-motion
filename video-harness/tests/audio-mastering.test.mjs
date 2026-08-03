import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAudioMixFilter,
  normalizeMasteringConfig,
  parseLoudnormReport,
} from "../lib/audio-mastering.mjs";

test("带 BGM 的混音会归一旁白、侧链压低音乐并限制最终峰值", () => {
  const filter = buildAudioMixFilter({
    hasBgm: true,
    volume: 0.15,
    totalDuration: 12.5,
    mastering: normalizeMasteringConfig({}),
  });
  assert.match(filter, /loudnorm=I=-16/);
  assert.match(filter, /sidechaincompress=/);
  assert.match(filter, /volume=0\.15/);
  assert.match(filter, /loudnorm=I=-14/);
  assert.match(filter, /alimiter=/);
  assert.match(filter, /apad=whole_dur=12\.5/);
});

test("关闭 BGM 侧链时仍保留旁白响度和峰值保护", () => {
  const filter = buildAudioMixFilter({
    hasBgm: false,
    totalDuration: 8,
    mastering: normalizeMasteringConfig({ ducking: { enabled: false } }),
  });
  assert.doesNotMatch(filter, /sidechaincompress=/);
  assert.match(filter, /loudnorm=I=-16/);
  assert.match(filter, /alimiter=/);
});

test("FFmpeg loudnorm JSON 会转换为交付质检指标", () => {
  const report = parseLoudnormReport(`frame=1\n{
    "input_i" : "-14.21",
    "input_tp" : "-1.03",
    "input_lra" : "3.40",
    "input_thresh" : "-24.00",
    "output_i" : "-14.00",
    "output_tp" : "-1.00",
    "output_lra" : "3.20",
    "output_thresh" : "-24.00",
    "normalization_type" : "dynamic",
    "target_offset" : "-0.01"
  }`);
  assert.deepEqual(report, { integratedLufs: -14.21, truePeakDb: -1.03, loudnessRangeLu: 3.4 });
});
