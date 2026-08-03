import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAudioReadiness } from "./audio-readiness.mjs";
import {
  DEFAULT_AUDIO_ENGINE,
  DEFAULT_HYPERFRAMES_LAUNCHER,
  DEFAULT_NPM_CACHE,
} from "./audio-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(HERE, "..", "..");

function commandCheck(command, args = ["--version"]) {
  let result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error?.code === "ENOENT" && process.platform === "win32" && !command.includes(".")) {
    result = spawnSync(`${command}.cmd`, args, { encoding: "utf8", windowsHide: true });
  }
  if (process.platform === "win32" && ["ENOENT", "EINVAL"].includes(result.error?.code)) {
    const located = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
    if (located.status === 0) {
      return {
        ok: true,
        detail: "已在 PATH 中找到（Windows 命令入口）",
      };
    }
  }
  return {
    ok: result.status === 0,
    detail: result.status === 0
      ? String(result.stdout || result.stderr).trim().split(/\r?\n/)[0]
      : String(result.error?.message || result.stderr || "未找到").trim(),
  };
}

function ffmpegAudioFilterCheck() {
  const required = ["loudnorm", "sidechaincompress", "alimiter", "volumedetect"];
  const result = spawnSync("ffmpeg", ["-hide_banner", "-filters"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const missing = required.filter((name) => !new RegExp(`\\b${name}\\b`, "u").test(output));
  return {
    ok: result.status === 0 && missing.length === 0,
    detail: missing.length === 0 ? `已包含 ${required.join("、")}` : `缺少 ${missing.join("、")}`,
  };
}

export function runDoctor(projectRoot = null) {
  const node = commandCheck(process.execPath, ["--version"]);
  const ffmpeg = commandCheck("ffmpeg", ["-version"]);
  const ffprobe = commandCheck("ffprobe", ["-version"]);
  const powershell = commandCheck("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
  const claude = commandCheck("claude", ["--version"]);
  const audioFilters = ffmpegAudioFilterCheck();
  const paths = {
    audioEngine: DEFAULT_AUDIO_ENGINE,
    captionsSkill: join(WORKSPACE_ROOT, "exampleFolder", ".claude", "skills", "faceless-explainer", "scripts", "captions.mjs"),
    hyperframesLauncher: DEFAULT_HYPERFRAMES_LAUNCHER,
    npmCache: DEFAULT_NPM_CACHE,
  };
  const checks = [
    { name: "Node.js", required: true, ...node },
    { name: "FFmpeg", required: true, ...ffmpeg },
    { name: "FFprobe", required: true, ...ffprobe },
    { name: "FFmpeg 音频母带滤镜", required: true, ...audioFilters },
    { name: "PowerShell", required: true, ...powershell },
    { name: "Claude CLI（外部场景自动构建）", required: false, ...claude },
    { name: "项目本地音频引擎", required: true, ok: existsSync(paths.audioEngine), detail: paths.audioEngine },
    { name: "项目本地字幕能力", required: true, ok: existsSync(paths.captionsSkill), detail: paths.captionsSkill },
    { name: "项目本地 HyperFrames 入口", required: true, ok: existsSync(paths.hyperframesLauncher), detail: paths.hyperframesLauncher },
    { name: "项目本地 npm 缓存", required: true, ok: existsSync(paths.npmCache), detail: paths.npmCache },
  ];
  if (projectRoot) {
    checks.push({
      name: "Video Harness 项目",
      required: true,
      ok: existsSync(join(projectRoot, "project.json")),
      detail: resolve(projectRoot),
    });
  }
  const audio = projectRoot ? inspectAudioReadiness(projectRoot) : null;
  if (audio) {
    checks.push({
      name: `生产 TTS 路由（${audio.provider}）`,
      required: true,
      ok: audio.ready,
      detail: audio.ready ? `已通过本地预检；字词时间戳：${audio.wordTiming.mode}` : audio.errors.join("；"),
    });
  }
  return {
    ok: checks.every((check) => !check.required || check.ok),
    workspaceRoot: WORKSPACE_ROOT,
    localOnly: true,
    credentials: {
      heygenConfigured: Boolean(process.env.HEYGEN_API_KEY || process.env.HYPERFRAMES_API_KEY),
      elevenlabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY),
      projectEnvExists: projectRoot ? existsSync(join(projectRoot, ".env")) : false,
    },
    audio,
    checks,
  };
}
