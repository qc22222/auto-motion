import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_FILES, SCHEMA_VERSION } from "./constants.mjs";
import {
  buildAudioMixFilter,
  measureLoudness,
  normalizeMasteringConfig,
} from "./audio-mastering.mjs";
import {
  ensureDir,
  hashFiles,
  hashValue,
  nowIso,
  readJson,
  toPosix,
  writeJson,
  writeText,
} from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import { probeVideo } from "./render.mjs";
import { invalidateFrom, setStage } from "./state.mjs";

function escapeConcatPath(path) {
  return toPosix(resolve(path)).replaceAll("'", "'\\''");
}

function escapeSubtitlePath(path) {
  return toPosix(resolve(path)).replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1\\:").replaceAll("'", "\\'");
}

function runFfmpeg(args, label) {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label}失败：${String(result.stderr || result.stdout).trim()}`);
  }
}

function concatScenes(model, outputPath) {
  const listPath = join(model.root, ".harness", "concat-scenes.txt");
  const lines = model.storyboard.scenes.map((scene) => {
    const path = join(model.root, "renders", `${scene.id}.mp4`);
    if (!existsSync(path)) throw new Error(`缺少场景渲染：renders/${scene.id}.mp4`);
    return `file '${escapeConcatPath(path)}'`;
  });
  writeText(listPath, lines.join("\n"));
  runFfmpeg(
    ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath],
    "场景拼接",
  );
}

function muxAudio(model, videoPath, outputPath, audioMeta) {
  const narrationPath = join(model.root, audioMeta.narration?.path || PROJECT_FILES.narration);
  if (!existsSync(narrationPath)) {
    copyFileSync(videoPath, outputPath);
    return { hasAudio: false, bgm: false, mastering: null };
  }
  const total = Number(model.storyboard.totalDuration);
  const mastering = normalizeMasteringConfig(model.project.audio?.mastering);
  const bgmPath = audioMeta.bgm?.path ? join(model.root, audioMeta.bgm.path) : null;
  if (bgmPath && existsSync(bgmPath)) {
    const requestedVolume = Number(model.project.audio?.bgm?.volume ?? audioMeta.bgm.volume ?? 0.12);
    const volume = Number.isFinite(requestedVolume) && requestedVolume >= 0 && requestedVolume <= 1
      ? requestedVolume
      : 0.12;
    runFfmpeg(
      [
        "-i",
        videoPath,
        "-i",
        narrationPath,
        "-stream_loop",
        "-1",
        "-i",
        bgmPath,
        "-filter_complex",
        buildAudioMixFilter({ hasBgm: true, volume, totalDuration: total, mastering }),
        "-map",
        "0:v:0",
        "-map",
        "[audio]",
        "-c:v",
        "copy",
        "-c:a",
        model.project.render.audioCodec || "aac",
        "-t",
        String(total),
        "-movflags",
        "+faststart",
        outputPath,
      ],
      "音轨混合",
    );
    return { hasAudio: true, bgm: true, mastering };
  }
  runFfmpeg(
    [
      "-i",
      videoPath,
      "-i",
      narrationPath,
      "-filter_complex",
      buildAudioMixFilter({ hasBgm: false, totalDuration: total, mastering }),
      "-map",
      "0:v:0",
      "-map",
      "[audio]",
      "-c:v",
      "copy",
      "-c:a",
      model.project.render.audioCodec || "aac",
      "-t",
      String(total),
      "-movflags",
      "+faststart",
      outputPath,
    ],
    "旁白封装",
  );
  return { hasAudio: true, bgm: false, mastering };
}

function burnCaptions(model, inputPath, outputPath) {
  const captionsPath = join(model.root, PROJECT_FILES.captionsSrt);
  const assPath = join(model.root, PROJECT_FILES.captionsAss);
  const captions = readJson(join(model.root, PROJECT_FILES.captionGroups), { groups: [] });
  if (!model.project.render.burnCaptions || captions.groups.length === 0 || !existsSync(captionsPath)) {
    copyFileSync(inputPath, outputPath);
    return false;
  }
  const filter = existsSync(assPath)
    ? `subtitles=filename='${escapeSubtitlePath(assPath)}'`
    : `subtitles=filename='${escapeSubtitlePath(captionsPath)}':charenc=UTF-8`;
  runFfmpeg(
    [
      "-i",
      inputPath,
      "-vf",
      filter,
      "-c:v",
      model.project.render.videoCodec || "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      model.project.render.pixelFormat || "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    "字幕烧录",
  );
  return true;
}

function validateDelivery(model, outputPath, audioResult, options = {}) {
  const probe = probeVideo(outputPath);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  const errors = [];
  if (!video) errors.push("最终成片缺少视频流");
  if (audioResult.hasAudio && !audio) errors.push("最终成片缺少音频流");
  if (!Number.isFinite(duration) || Math.abs(duration - Number(model.storyboard.totalDuration)) > 0.3) {
    errors.push(`最终时长与 Storyboard 不一致：${duration}s / ${model.storyboard.totalDuration}s`);
  }
  if (video && (video.width !== model.project.render.width || video.height !== model.project.render.height)) {
    errors.push(`最终分辨率不正确：${video.width}x${video.height}`);
  }
  let audioQc = null;
  if (audioResult.hasAudio && options.skipAudioQc) {
    audioQc = { skipped: true, reason: "mock-audio" };
  } else if (audioResult.hasAudio) {
    const targetLufs = audioResult.bgm
      ? audioResult.mastering.mixLufs
      : audioResult.mastering.narrationLufs;
    const report = measureLoudness(outputPath, targetLufs);
    audioQc = { skipped: false, targetLufs, ...report };
    if (!report.available || report.integratedLufs == null || report.truePeakDb == null) {
      errors.push("最终音轨无法取得有效的响度与真峰值报告");
    } else {
      if (Math.abs(report.integratedLufs - targetLufs) > 3) {
        errors.push(`最终综合响度偏离目标：${report.integratedLufs} LUFS / 目标 ${targetLufs} LUFS`);
      }
      if (report.truePeakDb > -0.05) {
        errors.push(`最终真峰值存在削波风险：${report.truePeakDb} dBTP`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`交付验证失败：\n- ${errors.join("\n- ")}`);
  return { duration, video, audio: audio || null, audioQc };
}

export function assembleProject(projectRoot, options = {}) {
  const model = loadProjectModel(projectRoot);
  const audioMeta = readJson(join(model.root, PROJECT_FILES.audioMeta), { voices: [] });
  const inputHash = hashValue({
    scenes: model.storyboard.scenes.map((scene) => ({
      id: scene.id,
      hash: hashFiles(model.root, [`renders/${scene.id}.mp4`]),
    })),
    audio: existsSync(join(model.root, PROJECT_FILES.audioMeta))
      ? hashFiles(model.root, [PROJECT_FILES.audioMeta, PROJECT_FILES.narration])
      : null,
    captions: existsSync(join(model.root, PROJECT_FILES.captionGroups))
      ? hashFiles(model.root, [PROJECT_FILES.captionGroups, PROJECT_FILES.captionsSrt])
      : null,
    burnCaptions: model.project.render.burnCaptions,
    mixing: {
      bgmVolume: model.project.audio?.bgm?.volume,
      mastering: normalizeMasteringConfig(model.project.audio?.mastering),
    },
  });
  invalidateFrom(model.root, "delivery");
  setStage(model.root, "delivery", "running", { inputHash });
  try {
    if (audioMeta.mock && !options.allowMockAudio) {
      throw new Error("生产交付不允许使用模拟音频；仅测试时可显式启用 allowMockAudio");
    }
    if (audioMeta.bgm_pending) {
      throw new Error("背景音乐仍在生成或检索中，不能开始最终装配");
    }
    ensureDir(join(model.root, "delivery"));
    const videoOnly = join(model.root, ".harness", "assembled-video.mp4");
    const withAudio = join(model.root, ".harness", "assembled-av.mp4");
    const finalPath = join(model.root, "delivery", "final.mp4");
    concatScenes(model, videoOnly);
    const audioResult = muxAudio(model, videoOnly, withAudio, audioMeta);
    const captionsBurned = burnCaptions(model, withAudio, finalPath);
    const verification = validateDelivery(model, finalPath, audioResult, {
      skipAudioQc: Boolean(audioMeta.mock),
    });

    if (existsSync(join(model.root, PROJECT_FILES.captionsSrt))) {
      copyFileSync(join(model.root, PROJECT_FILES.captionsSrt), join(model.root, "delivery", "captions.srt"));
      copyFileSync(join(model.root, PROJECT_FILES.captionsVtt), join(model.root, "delivery", "captions.vtt"));
      if (existsSync(join(model.root, PROJECT_FILES.captionsAss))) {
        copyFileSync(join(model.root, PROJECT_FILES.captionsAss), join(model.root, "delivery", "captions.ass"));
      }
    }
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: nowIso(),
      projectId: model.project.id,
      video: "delivery/final.mp4",
      captions: captionsBurned ? "burned-and-sidecar" : "sidecar",
      audio: { ...audioResult, qc: verification.audioQc },
      duration: verification.duration,
      width: verification.video.width,
      height: verification.video.height,
      files: ["final.mp4", "captions.srt", "captions.vtt", "captions.ass"].filter((name) =>
        existsSync(join(model.root, "delivery", name)),
      ),
    };
    writeJson(join(model.root, "delivery", "manifest.json"), manifest);
    writeText(
      join(model.root, "delivery", "交付说明.md"),
      `# ${model.project.title} · 交付说明

- 成片：\`final.mp4\`
- 时长：${verification.duration.toFixed(3)} 秒
- 分辨率：${verification.video.width} × ${verification.video.height}
- 配音：${audioResult.hasAudio ? "已封装" : "无"}
- 背景音乐：${audioResult.bgm ? "已混合" : "无"}
- 音频质检：${verification.audioQc?.skipped ? "模拟音频，已跳过" : verification.audioQc?.available ? `${verification.audioQc.integratedLufs} LUFS / ${verification.audioQc.truePeakDb} dBTP` : "无音轨"}
- 字幕：${captionsBurned ? "已烧录，同时保留 SRT/VTT" : "未烧录，保留 SRT/VTT"}
`,
    );
    const outputHash = hashFiles(model.root, ["delivery/final.mp4", "delivery/manifest.json"]);
    setStage(model.root, "delivery", "complete", { inputHash, outputHash });
    return { ...manifest, outputHash, path: finalPath };
  } catch (error) {
    setStage(model.root, "delivery", "failed", { inputHash, error: error.message });
    throw error;
  }
}
