import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  DEFAULT_AUDIO_ENGINE,
  DEFAULT_HYPERFRAMES_LAUNCHER,
  DEFAULT_INDEXTTS2_MODEL_DIR,
  DEFAULT_INDEXTTS2_PYTHON,
  DEFAULT_INDEXTTS2_ROOT,
  DEFAULT_NPM_CACHE,
  DEFAULT_WHISPER_PATH,
} from "./audio-paths.mjs";
import { resolveInside } from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import { INDEXTTS2_REQUIRED_MODEL_PATHS } from "../../exampleFolder/.claude/skills/media-use/audio/scripts/lib/indextts2.mjs";
import { normalizeEngineLanguage } from "../../exampleFolder/.claude/skills/media-use/audio/scripts/lib/tts.mjs";

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function inspectHeygenCredential(projectEnv, env = process.env, home = homedir()) {
  if (String(env.HEYGEN_API_KEY || env.HYPERFRAMES_API_KEY || "").trim()) {
    return { configured: true, source: "environment", expired: false };
  }
  if (String(projectEnv.HEYGEN_API_KEY || projectEnv.HYPERFRAMES_API_KEY || "").trim()) {
    return { configured: true, source: "project-env", expired: false };
  }
  const path = join(env.HEYGEN_CONFIG_DIR || join(home, ".heygen"), "credentials");
  if (!existsSync(path)) return { configured: false, source: "none", expired: false };
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { configured: false, source: "none", expired: false };
  if (!raw.startsWith("{")) return { configured: true, source: "heygen-login", expired: false };
  try {
    const credential = JSON.parse(raw);
    const oauth = credential.oauth;
    if (oauth?.access_token) {
      const expired = Boolean(oauth.expires_at && new Date(oauth.expires_at).getTime() - 60_000 < Date.now());
      if (!expired) return { configured: true, source: "heygen-login", expired: false };
      if (!credential.api_key) return { configured: false, source: "heygen-login", expired: true };
    }
    if (credential.api_key) return { configured: true, source: "heygen-login", expired: false };
  } catch {
    return { configured: false, source: "heygen-login", expired: false };
  }
  return { configured: false, source: "none", expired: false };
}

function pythonCandidates(env = process.env) {
  if (env.HYPERFRAMES_PYTHON) return [[env.HYPERFRAMES_PYTHON]];
  return process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
}

function hasPythonModules(modules, env = process.env) {
  const source = `import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(m) for m in ${JSON.stringify(modules)}) else 1)`;
  for (const prefix of pythonCandidates(env)) {
    const result = spawnSync(prefix[0], [...prefix.slice(1), "-c", source], {
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    if (result.status === 0) return true;
  }
  return false;
}

function commandWorks(command, args = ["--help"], env = process.env) {
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true, env });
  return result.status === 0;
}

function alignmentAvailable(env = process.env, home = homedir()) {
  if (env.HYPERFRAMES_WHISPER_PATH && existsSync(env.HYPERFRAMES_WHISPER_PATH)) return true;
  if (existsSync(DEFAULT_WHISPER_PATH)) return true;
  if (env.HYPERFRAMES_PARAKEET && existsSync(env.HYPERFRAMES_PARAKEET)) return true;
  if (commandWorks("whisper-cli", ["--help"], env)) return true;
  if (commandWorks("parakeet-mlx", ["--help"], env)) return true;
  const root = join(home, ".cache", "hyperframes", "whisper", "whisper.cpp", "build");
  return [
    join(root, "bin", "whisper-cli"),
    join(root, "bin", "whisper-cli.exe"),
    join(root, "bin", "Release", "whisper-cli.exe"),
    join(root, "whisper-cli"),
    join(root, "Release", "whisper-cli.exe"),
  ].some((path) => existsSync(path));
}

function cachedHyperframesAvailable(npmCache = DEFAULT_NPM_CACHE) {
  const npxRoot = join(npmCache, "_npx");
  if (!existsSync(npxRoot)) return false;
  try {
    return readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .some((entry) => existsSync(join(npxRoot, entry.name, "node_modules", "hyperframes", "bin", "hyperframes.mjs")));
  } catch {
    return false;
  }
}

function capability(options, name, detector) {
  const override = options.capabilities?.[name];
  return override == null ? detector() : Boolean(override);
}

function engineLanguage(provider, language) {
  return provider === "kokoro" ? normalizeEngineLanguage(language, "kokoro") : String(language || "en");
}

function indexTtsRuntimeAvailable(root, python, env) {
  if (!existsSync(join(root, "indextts", "cli_v2.py")) || !existsSync(python)) return false;
  const sitePackages = join(root, ".venv", process.platform === "win32" ? "Lib/site-packages" : "lib/python3.11/site-packages");
  if (!existsSync(sitePackages)) return false;
  const pythonEnv = {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: [root, sitePackages, env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
  const result = spawnSync(
    python,
    ["-S", "-c", "import torch,torchaudio,indextts; raise SystemExit(0)"],
    { cwd: root, stdio: "ignore", windowsHide: true, env: pythonEnv },
  );
  return result.status === 0;
}

function indexTtsModelAvailable(modelDir) {
  return INDEXTTS2_REQUIRED_MODEL_PATHS.every((relativePath) => existsSync(join(modelDir, relativePath)));
}

function indexTtsCudaAvailable(root, python, env) {
  if (!existsSync(python)) return false;
  const sitePackages = join(root, ".venv", process.platform === "win32" ? "Lib/site-packages" : "lib/python3.11/site-packages");
  const pythonEnv = {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: [root, sitePackages, env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
  const result = spawnSync(
    python,
    ["-S", "-c", "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"],
    { cwd: root, stdio: "ignore", windowsHide: true, env: pythonEnv },
  );
  return result.status === 0;
}

export function inspectAudioReadiness(projectRoot, options = {}) {
  const model = loadProjectModel(projectRoot);
  const env = options.env || process.env;
  const home = options.home || homedir();
  const projectEnv = parseEnvFile(join(model.root, ".env"));
  const runtimeEnv = { ...projectEnv, ...env };
  const provider = model.voice.provider;
  const errors = [];
  const warnings = [];
  const checks = [];
  const addCheck = (id, label, ok, detail, fix = "") => {
    checks.push({ id, label, ok, detail, fix });
    if (!ok) errors.push(`${label}：${detail}${fix ? `；${fix}` : ""}`);
  };

  addCheck(
    "engine",
    "项目本地音频引擎",
    existsSync(options.engine || DEFAULT_AUDIO_ENGINE),
    options.engine || DEFAULT_AUDIO_ENGINE,
    "恢复 exampleFolder/.claude/skills/media-use/audio/scripts/audio.mjs",
  );

  const detectedHeygen = inspectHeygenCredential(projectEnv, env, home);
  const heygenCredential = capability(options, "heygenCredential", () => detectedHeygen.configured);
  let elevenlabsKey = false;
  let alignment = false;

  if (provider === "heygen") {
    addCheck(
      "heygen-credential",
      "HeyGen 凭据",
      heygenCredential,
      detectedHeygen.expired ? "登录令牌已过期" : heygenCredential ? `已配置（${detectedHeygen.source === "none" ? "测试覆盖" : detectedHeygen.source}）` : "未配置",
      detectedHeygen.expired ? "运行 HyperFrames auth refresh" : "登录 HeyGen，或在项目 .env 配置 HEYGEN_API_KEY",
    );
    if (model.voice.cloneRequired || normalizeEngineLanguage(model.voice.language, "alignment") !== "en") {
      addCheck("voice-id", "克隆音色 voiceId", Boolean(String(model.voice.voiceId || "").trim()), "尚未填写", "选择本人或已授权的 Starfish voiceId");
    }
    warnings.push("本地预检只确认凭据存在；voiceId 权限、账户额度和远程 API 仍需一次真实小样验证。 ");
  } else if (provider === "elevenlabs") {
    elevenlabsKey = capability(options, "elevenlabsKey", () =>
      Boolean(String(env.ELEVENLABS_API_KEY || projectEnv.ELEVENLABS_API_KEY || "").trim()),
    );
    addCheck("elevenlabs-key", "ElevenLabs 凭据", elevenlabsKey, elevenlabsKey ? "已配置" : "未配置", "在项目 .env 配置 ELEVENLABS_API_KEY");
    addCheck("voice-id", "ElevenLabs voiceId", Boolean(String(model.voice.voiceId || "").trim()), "尚未填写", "填写本人或已授权的 ElevenLabs voiceId");
    warnings.push("本地预检只确认 API Key 与 voiceId 已配置；音色权限、账户额度和远程 API 仍需一次真实小样验证。");
  } else if (provider === "kokoro") {
    const kokoroCli = capability(options, "kokoroCli", () =>
      existsSync(options.hyperframesLauncher || DEFAULT_HYPERFRAMES_LAUNCHER)
      && cachedHyperframesAvailable(options.npmCache || DEFAULT_NPM_CACHE),
    );
    const kokoroPython = capability(options, "kokoroPython", () =>
      hasPythonModules(["kokoro_onnx", "soundfile"], runtimeEnv),
    );
    alignment = capability(options, "alignment", () => alignmentAvailable(runtimeEnv, home));
    addCheck(
      "kokoro-cli",
      "Kokoro 项目本地命令",
      kokoroCli,
      kokoroCli ? "HyperFrames TTS 安全入口与项目缓存可用" : "缺少 hyperframes-local.ps1 或缓存中的 HyperFrames CLI",
      "先通过项目本地 HyperFrames 入口准备固定版本缓存",
    );
    addCheck(
      "kokoro-python",
      "Kokoro 项目 Python 依赖",
      kokoroPython,
      kokoroPython ? "kokoro_onnx 与 soundfile 可导入" : "缺少 kokoro_onnx 或 soundfile",
      "在项目专用虚拟环境安装依赖，并把 HYPERFRAMES_PYTHON 指向其中的 python.exe",
    );
    addCheck("word-alignment", "字词对齐能力", alignment, alignment ? "可用" : "whisper-cli/Parakeet 均不可用", "配置项目本地 HYPERFRAMES_WHISPER_PATH");
    addCheck("voice-id", "Kokoro 音色", Boolean(String(model.voice.voiceId || "").trim()), model.voice.voiceId ? `已选择 ${model.voice.voiceId}` : "尚未选择", "中文可选择 zf_xiaobei");
    addCheck("clone-mode", "音色模式", model.voice.cloneRequired !== true, model.voice.cloneRequired ? "Kokoro 不支持克隆音色" : "本地预置音色", "关闭 cloneRequired，或改用 HeyGen/ElevenLabs");
  } else if (provider === "indextts2") {
    const indexRoot = runtimeEnv.INDEXTTS2_ROOT || options.indexTtsRoot || DEFAULT_INDEXTTS2_ROOT;
    const indexPython = runtimeEnv.INDEXTTS2_PYTHON || options.indexTtsPython || DEFAULT_INDEXTTS2_PYTHON;
    const indexModel = runtimeEnv.INDEXTTS2_MODEL_DIR || options.indexTtsModelDir || DEFAULT_INDEXTTS2_MODEL_DIR;
    const runtimeReady = capability(options, "indexTtsRuntime", () => indexTtsRuntimeAvailable(indexRoot, indexPython, runtimeEnv));
    const modelReady = capability(options, "indexTtsModel", () => indexTtsModelAvailable(indexModel));
    const cudaReady = capability(options, "indexTtsCuda", () => indexTtsCudaAvailable(indexRoot, indexPython, runtimeEnv));
    alignment = capability(options, "alignment", () => alignmentAvailable(runtimeEnv, home));
    const referenceAudio = String(model.voice.referenceAudio || "").trim();
    let referencePath = "";
    try {
      referencePath = referenceAudio ? resolveInside(model.root, referenceAudio) : "";
    } catch {
      referencePath = "";
    }
    const referenceReady = Boolean(referencePath && existsSync(referencePath));
    addCheck("indextts2-runtime", "IndexTTS2 项目运行环境", runtimeReady, runtimeReady ? indexRoot : "源码或项目虚拟环境不可用", "运行 video-harness/tools/setup-indextts2.ps1");
    addCheck("indextts2-model", "IndexTTS2 最小模型集", modelReady, modelReady ? indexModel : "模型文件不完整", "运行最小化模型下载脚本，不要下载冗余检查点");
    addCheck("indextts2-cuda", "IndexTTS2 CUDA 推理", cudaReady, cudaReady ? "cuda:0 可用，允许 FP16 推理" : "CUDA 不可用；禁止回退到 CPU", "检查 NVIDIA 驱动与 CUDA 版 PyTorch");
    addCheck("reference-audio", "IndexTTS2 参考音频", referenceReady, referenceReady ? model.voice.referenceAudio : "项目内参考音频不存在", "把清晰参考音频放入 assets/reference 并填写相对路径");
    addCheck("reference-authorization", "参考音频授权", model.voice.referenceAudioAuthorized === true, model.voice.referenceAudioAuthorized === true ? "已明确确认" : "尚未确认", "仅可使用本人或已获授权的音频，并勾选授权确认");
    addCheck("clone-mode", "音色模式", model.voice.cloneRequired === true, model.voice.cloneRequired === true ? "参考音频克隆" : "IndexTTS2 必须启用 cloneRequired", "启用 cloneRequired");
    addCheck("word-alignment", "字词对齐能力", alignment, alignment ? "可用" : "whisper-cli/Parakeet 均不可用", "配置项目本地 HYPERFRAMES_WHISPER_PATH");
    warnings.push("IndexTTS2 仅执行本地 CUDA 推理，不训练模型；CUDA 预检失败时会直接阻断，不会回退到 CPU。");
  } else {
    addCheck("provider", "TTS 提供方", false, `不支持 ${provider}`, "使用 heygen、elevenlabs、kokoro 或 indextts2");
  }

  const bgm = model.project.audio?.bgm || { mode: "none" };
  if (!["none", "retrieve", "generate"].includes(bgm.mode)) {
    addCheck("bgm-mode", "背景音乐模式", false, `不支持 ${bgm.mode}`, "使用 none、retrieve 或 generate");
  } else if (bgm.mode === "retrieve") {
    addCheck("bgm-retrieve", "背景音乐检索", heygenCredential, heygenCredential ? "HeyGen 可用" : "缺少 HeyGen 凭据", "配置 HeyGen 或将模式改为 none");
  } else if (bgm.mode === "generate") {
    const bgmGenerate = capability(options, "bgmGenerate", () =>
      hasPythonModules(["transformers", "torch", "soundfile", "numpy"], runtimeEnv),
    );
    addCheck("bgm-generate", "本地背景音乐生成", bgmGenerate, bgmGenerate ? "依赖可用" : "缺少 MusicGen 依赖", "安装项目本地 MusicGen 依赖，或将模式改为 none");
  }

  const effectiveControls = ["provider", "language"];
  if (provider === "indextts2") effectiveControls.push("referenceAudio", "referenceAudioAuthorized");
  else effectiveControls.push("voiceId");
  if (["heygen", "elevenlabs", "kokoro", "indextts2"].includes(provider)) effectiveControls.push("speed");
  if (provider === "elevenlabs") effectiveControls.push("settings", "pronunciations");
  if (provider === "indextts2") effectiveControls.push("settings", "direction", "segment.delivery");
  const unsupportedControls = [];
  if (provider !== "indextts2") unsupportedControls.push("direction", "segment.delivery");
  if (!["elevenlabs", "indextts2"].includes(provider)) unsupportedControls.push("settings");
  if (provider !== "elevenlabs") unsupportedControls.push("pronunciations");
  if (unsupportedControls.length > 0) {
    warnings.push(`当前共享音频引擎尚未消费高级控制：${unsupportedControls.join("、")}。`);
  }

  const nativeWordTiming = ["heygen", "elevenlabs"].includes(provider);
  const wordTimingReady = provider === "heygen"
    ? heygenCredential
    : provider === "elevenlabs"
      ? elevenlabsKey
      : alignment;

  return {
    ready: errors.length === 0,
    provider,
    language: {
      requested: model.voice.language,
      engine: engineLanguage(provider, model.voice.language),
      alignment: normalizeEngineLanguage(model.voice.language, "alignment"),
    },
    credentialSource: provider === "heygen" && heygenCredential
      ? detectedHeygen.source === "none" ? "capability-override" : detectedHeygen.source
      : provider === "elevenlabs" && elevenlabsKey ? "environment-or-project-env" : "none",
    wordTiming: { mode: nativeWordTiming ? "native" : "alignment", ready: wordTimingReady },
    effectiveControls,
    unsupportedControls,
    checks,
    errors,
    warnings: warnings.map((warning) => warning.trim()),
  };
}

export function assertAudioReady(projectRoot, options = {}) {
  const report = inspectAudioReadiness(projectRoot, options);
  if (!report.ready) {
    throw new Error(`生产音频预检未通过：\n- ${report.errors.join("\n- ")}`);
  }
  return report;
}
