import { existsSync } from "node:fs";
import { join } from "node:path";
import { compileProject } from "./compile.mjs";
import { PROJECT_FILES, SCHEMA_VERSION } from "./constants.mjs";
import { hashValue, nowIso, readJson, writeJson, writeText } from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import { validateSceneSource } from "./scenes.mjs";
import { writeEditWorkbench } from "./workbench.mjs";
import {
  invalidateFrom,
  isApproved,
  loadState,
  setSceneStage,
  setStage,
} from "./state.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadRevisions(projectRoot) {
  return readJson(join(projectRoot, PROJECT_FILES.revisions), {
    schemaVersion: SCHEMA_VERSION,
    items: [],
  });
}

export function addReviewComment(projectRoot, options) {
  const model = loadProjectModel(projectRoot);
  const scene = model.storyboard.scenes.find((item) => item.id === options.sceneId);
  if (!scene) throw new Error(`找不到场景：${options.sceneId}`);
  const text = String(options.text || "").trim();
  if (!text) throw new Error("审阅意见不能为空");
  const revisions = loadRevisions(model.root);
  const createdAt = nowIso();
  const item = {
    id: `revision-${createdAt.replace(/\D/g, "").slice(0, 17)}-${revisions.items.length + 1}`,
    sceneId: scene.id,
    pass: options.pass || "final",
    text,
    status: "open",
    createdAt,
  };
  revisions.items.push(item);
  writeJson(join(model.root, PROJECT_FILES.revisions), revisions);
  invalidateFrom(model.root, item.pass === "storyboard" ? "storyboard" : "scenes", scene.id);
  if (item.pass !== "storyboard") setSceneStage(model.root, scene.id, "needs_revision");
  return item;
}

export function prepareRevision(projectRoot, sceneId) {
  compileProject(projectRoot);
  const model = loadProjectModel(projectRoot);
  const scene = model.storyboard.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`找不到场景：${sceneId}`);
  const revisions = loadRevisions(model.root);
  const items = revisions.items.filter((item) => item.sceneId === sceneId && item.status === "open");
  if (items.length === 0) throw new Error(`场景 ${sceneId} 没有待处理审阅意见`);
  const request = {
    schemaVersion: SCHEMA_VERSION,
    sceneId,
    source: scene.src,
    createdAt: nowIso(),
    comments: items.map(({ id, pass, text, createdAt }) => ({ id, pass, text, createdAt })),
  };
  writeJson(join(model.root, "scenes", sceneId, "revision-request.json"), request);
  writeText(
    join(model.root, "scenes", sceneId, "REVISION.md"),
    `# 场景局部返工：${sceneId}

只修改 \`project/\` 内与以下意见直接相关的内容，不要改动其他场景，也不要重做已经确认的部分。

${items.map((item, index) => `${index + 1}. ${item.text}`).join("\n")}

完成后依次执行：

1. 本场景 HyperFrames lint/check。
2. \`video-harness build --accept --scene ${sceneId}\`。
3. \`video-harness review\` 重新生成审阅页。
`,
  );
  setSceneStage(model.root, sceneId, "needs_revision");
  return request;
}

function reviewHtml(model, manifest, captions) {
  const cards = manifest.scenes
    .map((scene) => {
      const media = scene.renderExists
        ? `<video controls preload="metadata" src="../renders/${encodeURIComponent(scene.id)}.mp4"></video>`
        : scene.sourceExists
          ? `<iframe loading="lazy" src="../${scene.src.replaceAll("\\", "/")}"></iframe>`
          : `<div class="missing">场景源文件缺失</div>`;
      const comments = scene.comments.length
        ? `<ul>${scene.comments.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>`
        : "<p class=\"muted\">暂无待处理意见</p>";
      return `<article class="card">
  <div class="media">${media}</div>
  <div class="body">
    <div class="eyebrow">${escapeHtml(scene.id)} · ${scene.duration}s · ${escapeHtml(scene.state)}</div>
    <h2>${escapeHtml(scene.title)}</h2>
    <p>${escapeHtml(scene.summary)}</p>
    <div class="card-actions">
      <a href="../edit.html?target=storyboard&amp;id=${encodeURIComponent(scene.id)}">修改分镜参数</a>
      <a href="../edit.html?target=scene&amp;id=${encodeURIComponent(scene.id)}">修改这个画面</a>
    </div>
    <h3>审阅意见</h3>
    ${comments}
  </div>
</article>`;
    })
    .join("\n");
  const captionPreview = captions.groups
    .slice(0, 12)
    .map((group) => `<li><code>${group.start.toFixed(2)}–${group.end.toFixed(2)}</code> ${escapeHtml(group.text)} <a href="../edit.html?target=caption&amp;id=${encodeURIComponent(group.id)}">修改</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(model.project.title)} · 审阅</title>
  <style>
    :root { color-scheme: light; --paper: ${model.design.palette.canvas}; --ink: ${model.design.palette.ink}; --accent: ${model.design.palette.primary}; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; background: var(--paper); color: var(--ink); font-family: ${JSON.stringify(model.design.typography.body)}, sans-serif; }
    header { max-width: 1100px; margin: 0 auto 28px; }
    h1 { margin: 0 0 8px; font-size: clamp(34px, 5vw, 66px); }
    .summary { font-size: 18px; line-height: 1.6; }
    .global-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .global-actions a, .card-actions a, .captions a { display: inline-flex; align-items: center; padding: 8px 11px; border: 1px solid color-mix(in srgb, var(--ink) 22%, transparent); border-radius: 999px; color: var(--ink); background: color-mix(in srgb, white 72%, var(--paper)); font-size: 13px; font-weight: 700; text-decoration: none; }
    .global-actions a:first-child { border-color: var(--accent); background: var(--accent); color: white; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 4px; }
    .grid { max-width: 1400px; margin: auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 22px; }
    .card { overflow: hidden; border: 2px solid color-mix(in srgb, var(--ink) 18%, transparent); border-radius: 18px; background: color-mix(in srgb, white 62%, var(--paper)); }
    .media { aspect-ratio: ${model.project.render.width} / ${model.project.render.height}; background: #111; }
    iframe, video { width: 100%; height: 100%; border: 0; object-fit: contain; }
    .missing { height: 100%; display: grid; place-items: center; color: white; }
    .body { padding: 20px; }
    .eyebrow { color: var(--accent); font-weight: 700; letter-spacing: .04em; }
    h2 { margin: 8px 0; font-size: 30px; }
    h3 { margin: 18px 0 6px; font-size: 17px; }
    p, li { line-height: 1.55; }
    .muted { opacity: .58; }
    .captions { max-width: 1100px; margin: 34px auto; padding: 22px; border: 2px dashed color-mix(in srgb, var(--ink) 25%, transparent); }
    code { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(model.project.title)}</h1>
    <div class="summary">${escapeHtml(model.project.workflow.message)} · ${manifest.totalDuration}s · ${manifest.scenes.length} 个场景 · ${captions.groups.length} 组字幕</div>
    <div class="global-actions">
      <a href="../edit.html?target=script">修改旁白</a>
      <a href="../edit.html?target=voice">修改音色</a>
      <a href="../edit.html?target=design">修改全局设计</a>
      <a href="../edit.html?target=delivery">修改声音与交付</a>
    </div>
  </header>
  <main class="grid">${cards}</main>
  <section class="captions"><h2>字幕抽查</h2><ol>${captionPreview}</ol></section>
</body>
</html>
`;
}

export function generateReview(projectRoot) {
  compileProject(projectRoot);
  const model = loadProjectModel(projectRoot);
  const state = loadState(model.root);
  const revisions = loadRevisions(model.root);
  const captions = readJson(join(model.root, PROJECT_FILES.captionGroups), { groups: [] });
  const scenes = model.storyboard.scenes.map((scene) => {
    const sourceValidation = validateSceneSource(model, scene);
    return {
      id: scene.id,
      title: scene.title,
      summary: scene.summary,
      duration: scene.duration,
      src: scene.src,
      state: state.sceneStates[scene.id]?.status || "unknown",
      sourceExists: existsSync(join(model.root, scene.src)),
      renderExists: existsSync(join(model.root, "renders", `${scene.id}.mp4`)),
      validation: sourceValidation,
      comments: revisions.items.filter((item) => item.sceneId === scene.id && item.status === "open"),
    };
  });
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    projectId: model.project.id,
    totalDuration: model.storyboard.totalDuration,
    captions: { groups: captions.groups.length },
    scenes,
    readyForApproval: scenes.every((scene) => scene.state === "complete" && scene.validation.ok) &&
      revisions.items.every((item) => item.status !== "open"),
  };
  const inputHash = hashValue({
    scenes: scenes.map((scene) => ({
      id: scene.id,
      state: scene.state,
      source: scene.validation.ok,
      outputHash: state.sceneStates[scene.id]?.outputHash,
    })),
    captions: state.stages.captions.outputHash,
    openComments: revisions.items.filter((item) => item.status === "open"),
  });
  const previousHash = state.stages.review.inputHash;
  if (previousHash && previousHash !== inputHash) invalidateFrom(model.root, "review");
  writeJson(join(model.root, PROJECT_FILES.reviewManifest), manifest);
  writeText(join(model.root, PROJECT_FILES.reviewHtml), reviewHtml(model, manifest, captions));
  writeEditWorkbench(model.root);
  setStage(model.root, "review", isApproved(model.root, "review") && previousHash === inputHash ? "approved" : "needs_approval", {
    inputHash,
    outputHash: hashValue(manifest),
  });
  return manifest;
}

export function assertReviewReady(projectRoot) {
  const manifest = existsSync(join(projectRoot, PROJECT_FILES.reviewManifest))
    ? readJson(join(projectRoot, PROJECT_FILES.reviewManifest))
    : generateReview(projectRoot);
  if (!manifest.readyForApproval) {
    const reasons = [];
    for (const scene of manifest.scenes) {
      if (scene.state !== "complete") reasons.push(`${scene.id} 状态为 ${scene.state}`);
      if (!scene.validation.ok) reasons.push(`${scene.id} 源文件校验未通过`);
      if (scene.comments.length > 0) reasons.push(`${scene.id} 仍有 ${scene.comments.length} 条待处理意见`);
    }
    throw new Error(`当前审阅尚不能批准：\n- ${reasons.join("\n- ")}`);
  }
  return manifest;
}
