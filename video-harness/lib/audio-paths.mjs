import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_AUDIO_ENGINE = join(
  WORKSPACE_ROOT,
  "exampleFolder",
  ".claude",
  "skills",
  "media-use",
  "audio",
  "scripts",
  "audio.mjs",
);
export const DEFAULT_BGM_WAITER = join(
  WORKSPACE_ROOT,
  "exampleFolder",
  ".claude",
  "skills",
  "media-use",
  "audio",
  "scripts",
  "wait-bgm.mjs",
);
export const DEFAULT_HYPERFRAMES_LAUNCHER = join(
  WORKSPACE_ROOT,
  "exampleFolder",
  "hyperframes-local.ps1",
);
export const DEFAULT_NPM_CACHE = join(WORKSPACE_ROOT, ".codex", "npm-cache");
export const DEFAULT_INDEXTTS2_ROOT = join(WORKSPACE_ROOT, ".codex", "runtime", "indextts2");
export const DEFAULT_INDEXTTS2_PYTHON = join(DEFAULT_INDEXTTS2_ROOT, ".venv", "Scripts", "python.exe");
// sentencepiece 等原生库无法打开含中文的路径，模型必须放在纯 ASCII 目录。
export const DEFAULT_INDEXTTS2_MODEL_DIR = "E:/models/indextts2";
export const DEFAULT_WHISPER_PATH = join(
  WORKSPACE_ROOT,
  ".codex",
  "runtime",
  "whisper",
  "v1.8.6",
  "whisper-cli.exe",
);
