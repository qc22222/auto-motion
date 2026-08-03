import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative } from "node:path";
import { inspectAudioReadiness } from "./audio-readiness.mjs";
import { generateAudio } from "./audio.mjs";
import { applyProjectEdit, getEditCatalog, previewProjectEdit } from "./editor.mjs";
import { resolveInside } from "./fs-utils.mjs";
import { generateScenes } from "./generator.mjs";
import { createJobManager } from "./job-manager.mjs";
import { loadProjectModel, projectRootFrom } from "./model.mjs";
import { advanceProject } from "./pipeline.mjs";
import { addReviewComment, assertReviewReady } from "./review.mjs";
import {
  approve,
  loadApprovals,
  loadState,
  requireApproval,
  requireStage,
} from "./state.mjs";
import { buildEditWorkbenchHtml } from "./workbench.mjs";

const MAX_BODY_BYTES = 256 * 1024;
const STATIC_PREFIXES = ["reviews/", "scenes/", "renders/", "captions/", "compositions/", "assets/"];
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".srt": "application/x-subrip; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};
const APPROVAL_STAGES = new Set(["script", "storyboard", "review"]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; media-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'",
  });
  response.end(body);
}

function assertMutationRequest(request, allowedOrigins) {
  if (request.headers["x-video-harness"] !== "1") throw Object.assign(new Error("缺少本地工作台请求标记"), { statusCode: 403 });
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("修改接口只接受 application/json"), { statusCode: 415 });
  }
  const origin = String(request.headers.origin || "");
  if (!allowedOrigins.has(origin)) throw Object.assign(new Error("拒绝非本地同源修改请求"), { statusCode: 403 });
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("请求体超过 256KB 限制"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (error) {
    throw Object.assign(new Error(`请求 JSON 无效：${error.message}`), { statusCode: 400 });
  }
}

function assertBodyKeys(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("请求体必须是 JSON 对象"), { statusCode: 400 });
  }
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`请求包含不允许的参数：${unknown.join("、")}`), { statusCode: 400 });
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(`${label}不能为空`), { statusCode: 400 });
  if (text.length > maxLength) {
    throw Object.assign(new Error(`${label}不能超过 ${maxLength} 个字符`), { statusCode: 400 });
  }
  return text;
}

function safeStaticPath(root, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    throw Object.assign(new Error("URL 编码无效"), { statusCode: 400 });
  }
  if (!STATIC_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return null;
  const path = resolveInside(root, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const rel = relative(realRoot, realPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return realPath;
}

function serveFile(request, response, path) {
  const stat = statSync(path);
  const contentType = MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
    if (!match) {
      response.writeHead(416, { "content-range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
      response.writeHead(416, { "content-range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "content-type": contentType,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
}

export async function startHarnessServer(projectRoot, options = {}) {
  const root = projectRootFrom(projectRoot);
  const host = String(options.host || "127.0.0.1");
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new Error("修改服务只能绑定本机回环地址");
  }
  const requestedPort = Number(options.port ?? 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("端口必须是 0 到 65535 的整数");
  const jobs = createJobManager();
  const pipelineOptions = { echo: false, ...(options.pipelineOptions || {}) };
  const generationOptions = { echo: false, ...(options.generationOptions || {}) };
  const assertIdle = () => {
    const activeJob = jobs.active();
    if (activeJob) {
      throw Object.assign(new Error(`任务 ${activeJob.type} 正在写入项目，请等待完成后再修改`), { statusCode: 409 });
    }
  };
  let allowedOrigins = new Set();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/edit/catalog") {
        sendJson(response, 200, getEditCatalog(root));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, {
          state: loadState(root),
          approvals: loadApprovals(root),
          activeJob: jobs.active(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/audio/readiness") {
        sendJson(response, 200, inspectAudioReadiness(root, options.audioReadinessOptions));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
        const job = jobs.get(id);
        if (!job) {
          sendJson(response, 404, { error: "找不到任务记录" });
          return;
        }
        sendJson(response, 200, job);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/edit/preview") {
        assertMutationRequest(request, allowedOrigins);
        sendJson(response, 200, previewProjectEdit(root, await readJsonBody(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/edit/apply") {
        assertMutationRequest(request, allowedOrigins);
        assertIdle();
        const body = await readJsonBody(request);
        sendJson(response, 200, applyProjectEdit(root, body, { expectedFingerprint: body.expectedFingerprint }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pipeline/advance") {
        assertMutationRequest(request, allowedOrigins);
        const body = await readJsonBody(request);
        assertBodyKeys(body, new Set());
        const job = jobs.start("pipeline.advance", {}, () => advanceProject(root, pipelineOptions));
        sendJson(response, 202, { job });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/audio/regenerate") {
        assertMutationRequest(request, allowedOrigins);
        const body = await readJsonBody(request);
        assertBodyKeys(body, new Set(["segmentId"]));
        const segmentId = body.segmentId == null ? null : requiredText(body.segmentId, "旁白段落 ID", 200);
        if (segmentId && !loadProjectModel(root).script.segments.some((segment) => segment.id === segmentId)) {
          throw Object.assign(new Error(`找不到旁白段落：${segmentId}`), { statusCode: 400 });
        }
        const job = jobs.start("audio.regenerate", { segmentId }, () => {
          requireStage(root, "script", ["approved"]);
          requireApproval(root, "script");
          const meta = generateAudio(root, {
            mock: Boolean(pipelineOptions.mockAudio),
            engine: pipelineOptions.audioEngine,
            readinessOptions: options.audioReadinessOptions,
            forceTts: !segmentId,
            forceTtsLine: segmentId,
          });
          return {
            segmentId,
            voices: meta.voices.map((voice) => ({ id: voice.id, path: voice.path, cache: voice.cache || null })),
            ttsCache: meta.tts_cache,
          };
        });
        sendJson(response, 202, { job });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/stages/approve") {
        assertMutationRequest(request, allowedOrigins);
        assertIdle();
        const body = await readJsonBody(request);
        assertBodyKeys(body, new Set(["stage", "note"]));
        const stage = requiredText(body.stage, "阶段", 40);
        if (!APPROVAL_STAGES.has(stage)) {
          throw Object.assign(new Error("工作台只允许批准 script、storyboard、review 三个质量门"), { statusCode: 400 });
        }
        const note = String(body.note || "").trim();
        if (note.length > 1000) throw Object.assign(new Error("审批说明不能超过 1000 个字符"), { statusCode: 400 });
        if (stage === "review") assertReviewReady(root);
        const record = approve(root, stage, note);
        sendJson(response, 200, { stage, record, state: loadState(root), approvals: loadApprovals(root) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/review/comments") {
        assertMutationRequest(request, allowedOrigins);
        assertIdle();
        const body = await readJsonBody(request);
        assertBodyKeys(body, new Set(["sceneId", "pass", "text"]));
        const sceneId = requiredText(body.sceneId, "镜头 ID", 200);
        const text = requiredText(body.text, "审阅意见", 5000);
        const pass = body.pass == null ? "final" : requiredText(body.pass, "审阅阶段", 40);
        if (!["storyboard", "final"].includes(pass)) {
          throw Object.assign(new Error("审阅阶段只支持 storyboard 或 final"), { statusCode: 400 });
        }
        sendJson(response, 200, addReviewComment(root, { sceneId, pass, text }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/scenes/generate") {
        assertMutationRequest(request, allowedOrigins);
        const body = await readJsonBody(request);
        assertBodyKeys(body, new Set(["sceneId"]));
        const sceneId = requiredText(body.sceneId, "镜头 ID", 200);
        const job = jobs.start("scene.generate", { sceneId }, async () => {
          requireStage(root, "storyboard", ["complete", "approved"]);
          requireApproval(root, "storyboard");
          return generateScenes(root, { ...generationOptions, sceneId });
        });
        sendJson(response, 202, { job });
        return;
      }
      if (request.method === "GET" && ["/edit", "/edit.html"].includes(url.pathname)) {
        sendHtml(response, buildEditWorkbenchHtml(getEditCatalog(root)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const location = existsSync(join(root, "reviews", "index.html")) ? "/reviews/index.html" : "/edit";
        response.writeHead(302, { location, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (["GET", "HEAD"].includes(request.method || "")) {
        const path = safeStaticPath(root, url.pathname);
        if (path) {
          serveFile(request, response, path);
          return;
        }
      }
      sendJson(response, 404, { error: "未找到请求资源" });
    } catch (error) {
      sendJson(response, Number(error.statusCode) || 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const displayHost = host === "::1" ? "[::1]" : host === "localhost" ? "localhost" : "127.0.0.1";
  const url = `http://${displayHost}:${address.port}`;
  allowedOrigins = new Set([url, `http://localhost:${address.port}`, `http://127.0.0.1:${address.port}`]);
  return {
    server,
    root,
    host,
    port: address.port,
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
