import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashFiles, hashValue, writeText } from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import { invalidateFrom, loadState, setSceneStage, setStage } from "./state.mjs";

function selectedScenes(model, sceneId) {
  if (!sceneId) return model.storyboard.scenes;
  const scene = model.storyboard.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`找不到场景：${sceneId}`);
  return [scene];
}

export function probeVideo(path) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=index,codec_type,width,height,r_frame_rate",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`ffprobe 失败：${String(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

function validateRender(model, scene, outputPath) {
  if (!existsSync(outputPath)) throw new Error(`场景渲染文件不存在：${outputPath}`);
  const probe = probeVideo(outputPath);
  const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const duration = Number(probe.format?.duration);
  const errors = [];
  if (!video) errors.push("缺少视频流");
  if (video && (Number(video.width) !== model.project.render.width || Number(video.height) !== model.project.render.height)) {
    errors.push(`分辨率应为 ${model.project.render.width}x${model.project.render.height}，实际为 ${video.width}x${video.height}`);
  }
  if (!Number.isFinite(duration) || Math.abs(duration - Number(scene.duration)) > 0.2) {
    errors.push(`时长应为 ${scene.duration}s，实际为 ${Number.isFinite(duration) ? duration.toFixed(3) : "未知"}s`);
  }
  if (errors.length > 0) throw new Error(`场景 ${scene.id} 渲染校验失败：\n- ${errors.join("\n- ")}`);
  return { duration, width: video.width, height: video.height, frameRate: video.r_frame_rate };
}

function renderMock(model, scene, outputPath) {
  const colors = Object.values(model.design.palette || {}).filter((value) => /^#[0-9a-f]{6}$/i.test(value));
  const color = (colors[(scene.index - 1) % colors.length] || "#222222").replace("#", "0x");
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${model.project.render.width}x${model.project.render.height}:r=${model.project.render.fps}:d=${scene.duration}`,
      "-an",
      "-c:v",
      model.project.render.videoCodec || "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      model.project.render.pixelFormat || "yuv420p",
      outputPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`模拟渲染失败：${String(result.stderr || result.stdout).trim()}`);
}

function renderHyperFrames(model, scene, outputPath, options) {
  const sceneProject = join(model.root, "scenes", scene.id, "project");
  const launcher = join(sceneProject, "hyperframes-local.ps1");
  if (!existsSync(launcher)) throw new Error(`场景 ${scene.id} 缺少项目本地 HyperFrames 入口`);
  const timeout = Number(options.timeoutMs) || 600_000;
  const check = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "check"],
    { cwd: sceneProject, encoding: "utf8", windowsHide: true, timeout },
  );
  writeText(join(model.root, ".harness", "logs", `${scene.id}-check.log`), `${check.stdout || ""}\n${check.stderr || ""}`);
  if (check.status !== 0) throw new Error(`场景 ${scene.id} HyperFrames check 失败`);
  const render = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "render",
      "--quality",
      options.quality || "high",
      "--output",
      outputPath,
    ],
    { cwd: sceneProject, encoding: "utf8", windowsHide: true, timeout },
  );
  writeText(join(model.root, ".harness", "logs", `${scene.id}-render.log`), `${render.stdout || ""}\n${render.stderr || ""}`);
  if (render.status !== 0) throw new Error(`场景 ${scene.id} HyperFrames render 失败`);
}

export function renderScenes(projectRoot, options = {}) {
  const model = loadProjectModel(projectRoot);
  const scenes = selectedScenes(model, options.sceneId);
  invalidateFrom(model.root, "render");
  const inputHash = hashValue(
    scenes.map((scene) => ({ scene, sourceHash: hashFiles(model.root, [scene.src]) })),
  );
  setStage(model.root, "render", "running", { inputHash });
  const results = [];
  try {
    for (const scene of scenes) {
      const outputPath = join(model.root, "renders", `${scene.id}.mp4`);
      if (options.accept) {
        if (!existsSync(outputPath)) throw new Error(`无法复用场景 ${scene.id}：渲染文件不存在`);
      } else if (options.mock) renderMock(model, scene, outputPath);
      else renderHyperFrames(model, scene, outputPath, options);
      const probe = validateRender(model, scene, outputPath);
      const outputHash = hashFiles(model.root, [`renders/${scene.id}.mp4`]);
      const sourceHash = hashFiles(model.root, [scene.src]);
      setSceneStage(model.root, scene.id, "complete", {
        render: { path: `renders/${scene.id}.mp4`, sourceHash, outputHash, ...probe },
      });
      results.push({ sceneId: scene.id, path: outputPath, sourceHash, outputHash, ...probe });
    }
    const state = loadState(model.root);
    const allRendered = model.storyboard.scenes.every((scene) => {
      const outputExists = existsSync(join(model.root, "renders", `${scene.id}.mp4`));
      const currentSourceHash = hashFiles(model.root, [scene.src]);
      return outputExists && state.sceneStates[scene.id]?.render?.sourceHash === currentSourceHash;
    });
    setStage(model.root, "render", allRendered ? "complete" : "ready", {
      inputHash,
      outputHash: hashValue(results),
    });
    return results;
  } catch (error) {
    setStage(model.root, "render", "failed", { inputHash, error: error.message });
    throw error;
  }
}
