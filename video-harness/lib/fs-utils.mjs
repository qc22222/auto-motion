import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function readJson(path, fallback) {
  if (!existsSync(path)) {
    if (arguments.length >= 2) return fallback;
    throw new Error(`文件不存在：${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`JSON 解析失败：${path}：${error.message}`);
  }
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export function readText(path, fallback) {
  if (!existsSync(path)) {
    if (arguments.length >= 2) return fallback;
    throw new Error(`文件不存在：${path}`);
  }
  return readFileSync(path, "utf8");
}

export function appendJsonLine(path, value) {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

export function resolveInside(root, candidate) {
  const rootPath = resolve(root);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootPath, candidate);
  const rel = relative(rootPath, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw new Error(`路径超出项目范围：${candidate}`);
}

export function assertEmptyOrMissing(path) {
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) throw new Error(`目标已存在且不是目录：${path}`);
  const entries = readdirSync(path);
  if (entries.length > 0) throw new Error(`目标目录已存在且非空：${path}`);
}

export function copyTree(source, destination) {
  if (!existsSync(source)) throw new Error(`复制源不存在：${source}`);
  ensureDir(destination);
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
}

export function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashFiles(root, relativePaths) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const rel of relativePaths) {
    const path = join(root, rel);
    hash.update(rel);
    if (!existsSync(path)) {
      hash.update("<missing>");
      continue;
    }
    const descriptor = openSync(path, "r");
    try {
      let bytesRead = 0;
      do {
        bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      closeSync(descriptor);
    }
  }
  return hash.digest("hex");
}

export function canonicalPath(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

export function nowIso() {
  return new Date().toISOString();
}

export function slugify(value) {
  const ascii = String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `video-${Date.now()}`;
}

export function toPosix(path) {
  return path.replaceAll("\\", "/");
}
