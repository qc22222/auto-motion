import { spawnSync } from "node:child_process";

export const DEFAULT_MASTERING = Object.freeze({
  narrationLufs: -16,
  mixLufs: -14,
  truePeakDb: -1,
  loudnessRangeLu: 11,
  ducking: Object.freeze({
    enabled: true,
    threshold: 0.03,
    ratio: 6,
    attackMs: 20,
    releaseMs: 350,
  }),
});

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeMasteringConfig(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const ducking = source.ducking && typeof source.ducking === "object" && !Array.isArray(source.ducking)
    ? source.ducking
    : {};
  return {
    narrationLufs: finiteOr(source.narrationLufs, DEFAULT_MASTERING.narrationLufs),
    mixLufs: finiteOr(source.mixLufs, DEFAULT_MASTERING.mixLufs),
    truePeakDb: finiteOr(source.truePeakDb, DEFAULT_MASTERING.truePeakDb),
    loudnessRangeLu: finiteOr(source.loudnessRangeLu, DEFAULT_MASTERING.loudnessRangeLu),
    ducking: {
      enabled: ducking.enabled == null ? DEFAULT_MASTERING.ducking.enabled : Boolean(ducking.enabled),
      threshold: finiteOr(ducking.threshold, DEFAULT_MASTERING.ducking.threshold),
      ratio: finiteOr(ducking.ratio, DEFAULT_MASTERING.ducking.ratio),
      attackMs: finiteOr(ducking.attackMs, DEFAULT_MASTERING.ducking.attackMs),
      releaseMs: finiteOr(ducking.releaseMs, DEFAULT_MASTERING.ducking.releaseMs),
    },
  };
}

function numberText(value) {
  return String(Number(Number(value).toFixed(4)));
}

export function buildAudioMixFilter({ hasBgm, volume = 0.12, totalDuration, mastering = {} }) {
  const config = normalizeMasteringConfig(mastering);
  const truePeak = numberText(config.truePeakDb);
  const limiter = numberText(Math.min(0.99, 10 ** (config.truePeakDb / 20)));
  const narration = `loudnorm=I=${numberText(config.narrationLufs)}:LRA=${numberText(config.loudnessRangeLu)}:TP=${truePeak}`;
  const end = `alimiter=limit=${limiter}:level=false,apad=whole_dur=${numberText(totalDuration)}`;
  if (!hasBgm) return `[1:a]${narration},${end}[audio]`;

  const parts = [
    `[1:a]${narration}[narr]`,
    `[2:a]volume=${numberText(volume)}[music]`,
  ];
  let musicLabel = "music";
  if (config.ducking.enabled) {
    parts.push(
      `[music][narr]sidechaincompress=threshold=${numberText(config.ducking.threshold)}:ratio=${numberText(config.ducking.ratio)}:attack=${numberText(config.ducking.attackMs)}:release=${numberText(config.ducking.releaseMs)}[ducked]`,
    );
    musicLabel = "ducked";
  }
  parts.push(
    `[narr][${musicLabel}]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=${numberText(config.mixLufs)}:LRA=${numberText(config.loudnessRangeLu)}:TP=${truePeak},${end}[audio]`,
  );
  return parts.join(";");
}

function metric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseLoudnormReport(stderrText) {
  const candidates = String(stderrText || "").match(/\{[\s\S]*?\}/gu) || [];
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate);
      if (!("input_i" in value) || !("input_tp" in value)) continue;
      return {
        integratedLufs: metric(value.input_i),
        truePeakDb: metric(value.input_tp),
        loudnessRangeLu: metric(value.input_lra),
      };
    } catch {
      // FFmpeg 的其他日志片段可能也包含花括号，继续寻找 loudnorm JSON。
    }
  }
  return null;
}

export function measureLoudness(path, targetLufs, options = {}) {
  const spawn = options.spawn || spawnSync;
  const result = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-af",
      `loudnorm=I=${numberText(targetLufs)}:LRA=11:TP=-1:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const report = parseLoudnormReport(result.stderr);
  return report ? { available: true, ...report } : { available: false, integratedLufs: null, truePeakDb: null, loudnessRangeLu: null };
}
