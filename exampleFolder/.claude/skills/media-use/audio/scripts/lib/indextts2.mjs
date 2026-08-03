import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnP } from "./tts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INDEXTTS2_WORKSPACE_ROOT = resolve(HERE, "../../../../../../../");
export const INDEXTTS2_REQUIRED_MODEL_PATHS = [
  "config.yaml",
  "bpe.model",
  "gpt.pth",
  "s2mel.pth",
  "wav2vec2bert_stats.pt",
  "feat1.pt",
  "feat2.pt",
  "qwen0.6bemo4-merge/config.json",
  "qwen0.6bemo4-merge/added_tokens.json",
  "qwen0.6bemo4-merge/chat_template.jinja",
  "qwen0.6bemo4-merge/generation_config.json",
  "qwen0.6bemo4-merge/merges.txt",
  "qwen0.6bemo4-merge/model.safetensors",
  "qwen0.6bemo4-merge/special_tokens_map.json",
  "qwen0.6bemo4-merge/tokenizer.json",
  "qwen0.6bemo4-merge/tokenizer_config.json",
  "qwen0.6bemo4-merge/vocab.json",
  "hf_cache/w2v-bert-2.0/config.json",
  "hf_cache/w2v-bert-2.0/preprocessor_config.json",
  "hf_cache/w2v-bert-2.0/model.safetensors",
  "hf_cache/semantic_codec_model.safetensors",
  "hf_cache/campplus_cn_common.bin",
  "hf_cache/bigvgan/config.json",
  "hf_cache/bigvgan/bigvgan_generator.pt",
];

function pathInside(root, candidate, label) {
  const base = resolve(root);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label}必须位于视频项目内`);
  }
  return target;
}

function parseEmotionVector(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length !== 8) throw new Error("IndexTTS2 情绪向量必须恰好包含 8 个数值");
  const vector = values.map(Number);
  if (vector.some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    throw new Error("IndexTTS2 情绪向量每一维都必须在 0 到 1 之间");
  }
  if (vector.reduce((sum, item) => sum + item, 0) > 0.800001) {
    throw new Error("IndexTTS2 情绪向量总和不得超过 0.8");
  }
  return vector;
}

export function normalizeIndexTts2Settings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const allowed = new Set([
    "emotionMode",
    "emotionText",
    "emotionVector",
    "emotionAudio",
    "emotionWeight",
  ]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`IndexTTS2 settings 包含不支持字段：${unknown.join("、")}`);
  const emotionMode = String(source.emotionMode || "none");
  if (!["none", "delivery", "text", "vector", "audio"].includes(emotionMode)) {
    throw new Error("IndexTTS2 emotionMode 仅支持 none、delivery、text、vector 或 audio");
  }
  const emotionWeight = source.emotionWeight == null ? 0.6 : Number(source.emotionWeight);
  if (!Number.isFinite(emotionWeight) || emotionWeight < 0 || emotionWeight > 1) {
    throw new Error("IndexTTS2 emotionWeight 必须在 0 到 1 之间");
  }
  const normalized = { emotionMode, emotionWeight };
  if (emotionMode === "text") {
    normalized.emotionText = String(source.emotionText || "").trim();
    if (!normalized.emotionText) throw new Error("IndexTTS2 文本情绪模式必须填写 emotionText");
  } else if (emotionMode === "vector") {
    normalized.emotionVector = parseEmotionVector(source.emotionVector);
  } else if (emotionMode === "audio") {
    normalized.emotionAudio = String(source.emotionAudio || "").trim();
    if (!normalized.emotionAudio) throw new Error("IndexTTS2 情绪参考音频模式必须填写 emotionAudio");
  }
  return normalized;
}

export function resolveIndexTts2Runtime(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || DEFAULT_INDEXTTS2_WORKSPACE_ROOT);
  const env = options.env || process.env;
  const sourceRoot = resolve(env.INDEXTTS2_ROOT || join(workspaceRoot, ".codex", "runtime", "indextts2"));
  const platform = options.platform || process.platform;
  const python = resolve(
    env.INDEXTTS2_PYTHON
      || join(sourceRoot, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  );
  // sentencepiece 无法打开含中文的路径，模型固定放在纯 ASCII 目录。
  const modelDir = resolve(env.INDEXTTS2_MODEL_DIR || "E:/models/indextts2");
  const sitePackages = resolve(
    sourceRoot,
    platform === "win32" ? ".venv/Lib/site-packages" : ".venv/lib/python3.11/site-packages",
  );
  const pathExists = options.pathExists || existsSync;
  if (!pathExists(sourceRoot)) throw new Error(`找不到 IndexTTS2 项目本地源码：${sourceRoot}`);
  if (!pathExists(python)) throw new Error(`找不到 IndexTTS2 项目本地 Python：${python}`);
  if (!pathExists(modelDir)) throw new Error(`找不到 IndexTTS2 单份模型目录：${modelDir}`);
  if (!pathExists(sitePackages)) throw new Error(`找不到 IndexTTS2 项目依赖目录：${sitePackages}`);
  return { workspaceRoot, sourceRoot, python, sitePackages, modelDir, device: "cuda:0", fp16: true };
}

// kaldifst（wetext）用 ANSI 编码打开 site-packages 内的 .fst 文件，运行时位于
// 中文路径时必须先用 subst 映射出一个纯 ASCII 盘符，再以映射路径执行推理。
export function ensureAsciiExecRoot(sourceRoot, deps = {}) {
  if (process.platform !== "win32" || !/[^\x00-\x7F]/.test(sourceRoot)) return sourceRoot;
  const run = deps.spawnSync || spawnSync;
  const listed = run("subst", [], { encoding: "utf8", windowsHide: true });
  const mappings = new Map();
  for (const line of String(listed.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z]):\\: => (.+)$/);
    if (match) mappings.set(match[1], resolve(match[2]));
  }
  const wanted = resolve(sourceRoot);
  for (const [letter, target] of mappings) {
    if (target === wanted) return `${letter}:\\`;
  }
  for (const letter of ["V", "W", "X", "Y", "Z"]) {
    if (mappings.has(letter) || existsSync(`${letter}:\\`)) continue;
    const created = run("subst", [`${letter}:`, wanted], { encoding: "utf8", windowsHide: true });
    if (created.status === 0) return `${letter}:\\`;
  }
  throw new Error(`IndexTTS2 运行时位于中文路径且无法建立 ASCII 盘符映射：${sourceRoot}`);
}

export function buildIndexTts2BatchRows({ lines, referenceAudio, settings, direction = "", outputForLine }) {  return lines.map((line) => {
    const row = {
      text: String(line.text),
      voice: referenceAudio,
      output: outputForLine(line),
    };
    if (settings.emotionMode === "delivery") {
      const delivery = [direction, line.delivery]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .join("；");
      if (!delivery) throw new Error(`IndexTTS2 段落 ${line.id} 缺少可用于情绪控制的演绎说明`);
      row.emotion_text = delivery;
      row.emotion_weight = settings.emotionWeight;
    } else if (settings.emotionMode === "text") {
      row.emotion_text = settings.emotionText;
      row.emotion_weight = settings.emotionWeight;
    } else if (settings.emotionMode === "vector") {
      row.emotion_vector = settings.emotionVector;
      row.emotion_weight = settings.emotionWeight;
    } else if (settings.emotionMode === "audio") {
      row.emotion_audio = settings.emotionAudio;
      row.emotion_weight = settings.emotionWeight;
    }
    return row;
  });
}

export function buildIndexTts2Invocation({ runtime, batchPath }) {
  return {
    cmd: runtime.python,
    args: [
      "-S",
      "-m",
      "indextts.cli_v2",
      "batch",
      "--batch-file",
      batchPath,
      "--model-dir",
      runtime.modelDir,
      "--device",
      "cuda:0",
      "--fp16",
      "--no-deepspeed",
      "--no-cuda-kernel",
      "--no-accel",
      "--no-torch-compile",
      "--force",
    ],
  };
}

export async function runIndexTts2Batch({
  lines,
  hyperframesDir,
  referenceAudio,
  settings,
  direction = "",
  outputForLine,
  runtimeOptions = {},
}, deps = {}) {
  const normalizedSettings = normalizeIndexTts2Settings(settings);
  const referencePath = pathInside(hyperframesDir, referenceAudio, "IndexTTS2 参考音频");
  if (!existsSync(referencePath)) throw new Error(`IndexTTS2 参考音频不存在：${referenceAudio}`);
  if (normalizedSettings.emotionMode === "audio") {
    normalizedSettings.emotionAudio = pathInside(
      hyperframesDir,
      normalizedSettings.emotionAudio,
      "IndexTTS2 情绪参考音频",
    );
    if (!existsSync(normalizedSettings.emotionAudio)) {
      throw new Error(`IndexTTS2 情绪参考音频不存在：${settings.emotionAudio}`);
    }
  }
  const runtime = resolveIndexTts2Runtime(runtimeOptions);
  const rows = buildIndexTts2BatchRows({
    lines,
    referenceAudio: referencePath,
    settings: normalizedSettings,
    direction,
    outputForLine,
  });
  const batchPath = join(hyperframesDir, ".harness", "audio-temp", "indextts2-batch.jsonl");
  mkdirSync(dirname(batchPath), { recursive: true });
  writeFileSync(batchPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const invocation = buildIndexTts2Invocation({ runtime, batchPath });
  const spawn = deps.spawn || spawnP;
  // 注入了 mock spawn 的测试环境不真正执行 subst，直接接受映射结果。
  const substRun = deps.spawnSync || (deps.spawn ? () => ({ status: 0, stdout: "" }) : spawnSync);
  const execRoot = ensureAsciiExecRoot(runtime.sourceRoot, { spawnSync: substRun });
  const execSitePackages = execRoot === runtime.sourceRoot
    ? runtime.sitePackages
    : join(execRoot, process.platform === "win32" ? ".venv/Lib/site-packages" : ".venv/lib/python3.11/site-packages");
  const pythonEnv = {
    ...process.env,
    ...runtimeOptions.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    INDEXTTS2_MODEL_DIR: runtime.modelDir,
    PYTHONPATH: [execRoot, execSitePackages, runtimeOptions.env?.PYTHONPATH || process.env.PYTHONPATH]
      .filter(Boolean)
      .join(delimiter),
  };
  const cudaCheck = await spawn(
    runtime.python,
    ["-S", "-c", "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"],
    { cwd: execRoot, stdio: "ignore", windowsHide: true, env: pythonEnv },
  );
  if (cudaCheck.status !== 0) {
    throw new Error("IndexTTS2 CUDA 预检失败；已禁止 CPU 推理回退");
  }
  const result = await spawn(invocation.cmd, invocation.args, {
    cwd: execRoot,
    stdio: "inherit",
    windowsHide: true,
    env: pythonEnv,
  });
  if (result.status !== 0) throw new Error(`IndexTTS2 GPU 批量推理失败（退出码 ${result.status}）`);
  for (const row of rows) {
    if (!existsSync(row.output)) throw new Error(`IndexTTS2 未生成预期音频：${row.output}`);
  }
  return { rows, runtime, batchPath };
}
