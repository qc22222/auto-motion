import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileProject } from "./compile.mjs";
import { PROJECT_FILES, SCHEMA_VERSION } from "./constants.mjs";
import {
  ensureDir,
  hashFiles,
  hashValue,
  readJson,
  toPosix,
  writeJson,
  writeText,
} from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import {
  invalidateFrom,
  loadState,
  setSceneStage,
  setStage,
} from "./state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(HERE, "..", "..");
const LOCAL_LAUNCHER = join(WORKSPACE_ROOT, "exampleFolder", "hyperframes-local.ps1");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function scaffoldSceneProject(model, scene) {
  const projectRoot = join(model.root, "scenes", scene.id, "project");
  ensureDir(join(projectRoot, "assets"));
  ensureDir(join(projectRoot, "renders"));
  writeJson(join(projectRoot, "hyperframes.json"), {
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://hyperframes.heygen.com/registry",
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
    media: { autoProxy: true },
    authoringSkill: "general-video",
  });
  writeJson(join(projectRoot, "package.json"), {
    name: `${model.project.id}-${scene.id}`.toLowerCase(),
    private: true,
    type: "module",
    scripts: {
      lint: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 lint",
      check: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 check",
      render: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 render",
    },
  });
  writeJson(join(projectRoot, ".hyperframes-local.json"), {
    localRoot: toPosix(WORKSPACE_ROOT),
    cliVersion: "0.7.88",
  });
  writeText(
    join(projectRoot, ".npmrc"),
    [
      `cache=${toPosix(join(WORKSPACE_ROOT, ".codex", "npm-cache"))}`,
      "update-notifier=false",
      "fund=false",
      "audit=false",
    ].join("\n"),
  );
  if (existsSync(LOCAL_LAUNCHER)) copyFileSync(LOCAL_LAUNCHER, join(projectRoot, "hyperframes-local.ps1"));
  writeText(
    join(projectRoot, "本地运行说明.md"),
    `# 本场景本地命令

\`\`\`powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 lint
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 render --quality high --output ../../../renders/${scene.id}.mp4
\`\`\`

所有缓存均固定在视频制作项目目录内，不安装全局技能或依赖。
`,
  );
  return projectRoot;
}

function buildMockSceneHtml(model, scene) {
  const { width, height } = model.project.render;
  const palette = model.design.palette;
  const safeX = model.design.layout.safeMarginX;
  const safeY = model.design.layout.safeMarginY;
  const duration = Number(scene.duration);
  const titleSize = Math.round(height * 0.055);
  const bodySize = Math.round(height * 0.026);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${width}, height=${height}" />
  <style>
    @font-face { font-family: ${JSON.stringify(model.design.typography.display)}; src: local(${JSON.stringify(model.design.typography.display)}); }
    @font-face { font-family: ${JSON.stringify(model.design.typography.body)}; src: local(${JSON.stringify(model.design.typography.body)}); }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${palette.canvas}; }
    body { font-family: ${JSON.stringify(model.design.typography.display)}, sans-serif; color: ${palette.ink}; }
    #root { position: relative; width: 100%; height: 100%; padding: ${safeY}px ${safeX}px; overflow: hidden; }
    .index { font-size: ${Math.round(bodySize * 0.68)}px; letter-spacing: 0.16em; color: ${palette.secondary}; }
    .accent { position: absolute; width: ${Math.round(width * 0.66)}px; height: ${Math.round(width * 0.66)}px; right: ${Math.round(-width * 0.26)}px; top: ${Math.round(height * 0.1)}px; border-radius: 50%; background: ${palette.primary}; }
    .rule { position: absolute; left: ${safeX}px; right: ${safeX}px; top: ${Math.round(height * 0.34)}px; height: ${Math.max(6, Math.round(width * 0.01))}px; background: ${palette.accent}; transform-origin: left center; }
    .copy { position: absolute; left: ${safeX}px; right: ${safeX}px; top: ${Math.round(height * 0.39)}px; }
    h1 { margin: 0; max-width: 86%; font-size: ${titleSize}px; line-height: 1.08; letter-spacing: -0.035em; }
    p { margin: ${Math.round(bodySize * 1.1)}px 0 0; max-width: 78%; font-family: ${JSON.stringify(model.design.typography.body)}, sans-serif; font-size: ${bodySize}px; line-height: 1.45; }
    .focal { position: absolute; left: ${safeX}px; bottom: ${Math.round(height * 0.2)}px; padding: ${Math.round(bodySize * 0.5)}px ${Math.round(bodySize * 0.8)}px; background: ${palette.secondary}; color: ${palette.canvas}; font-size: ${Math.round(bodySize * 0.72)}px; }
  </style>
</head>
<body>
  <main id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
    <div class="accent"></div>
    <div class="index">${String(scene.index).padStart(2, "0")} / ${String(model.storyboard.scenes.length).padStart(2, "0")}</div>
    <div class="rule"></div>
    <section class="copy">
      <h1>${escapeHtml(scene.title)}</h1>
      <p>${escapeHtml(scene.summary)}</p>
    </section>
    <div class="focal">${escapeHtml(scene.focal)}</div>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from(".accent", { scale: 0.25, opacity: 0, duration: 0.65, ease: "power3.out" }, 0);
    tl.from(".index", { y: 22, opacity: 0, duration: 0.4 }, 0.08);
    tl.from(".rule", { scaleX: 0, duration: 0.55, ease: "power3.out" }, 0.2);
    tl.from("h1", { y: 48, opacity: 0, duration: 0.65, ease: "power3.out" }, 0.35);
    tl.from("p", { y: 28, opacity: 0, duration: 0.5 }, 0.55);
    tl.from(".focal", { x: -36, opacity: 0, duration: 0.45 }, 0.75);
    tl.to(".accent", { x: -${Math.round(width * 0.06)}, duration: ${Math.max(0.4, duration - 1.1)}, ease: "none" }, 0.7);
    tl.to({}, { duration: ${duration} }, 0);
    window.__timelines = window.__timelines || {};
    window.__timelines.main = tl;
  </script>
</body>
</html>
`;
}

export function validateSceneSource(model, scene) {
  const sourcePath = join(model.root, scene.src);
  const errors = [];
  const warnings = [];
  if (!existsSync(sourcePath)) {
    errors.push(`场景源文件不存在：${scene.src}`);
    return { ok: false, errors, warnings, sourcePath };
  }
  const html = readFileSync(sourcePath, "utf8");
  if (!html.includes('data-composition-id="main"') && !html.includes("data-composition-id='main'")) {
    errors.push("缺少 data-composition-id=main");
  }
  const durationMatch = html.match(/data-duration=["']([0-9.]+)["']/i);
  if (!durationMatch) errors.push("缺少数值型 data-duration");
  else if (Math.abs(Number(durationMatch[1]) - Number(scene.duration)) > 0.02) {
    errors.push(`data-duration 与场景配置不一致：HTML=${durationMatch[1]}，配置=${scene.duration}`);
  }
  for (const [name, expected] of [["width", model.project.render.width], ["height", model.project.render.height]]) {
    const match = html.match(new RegExp(`data-${name}=["']([0-9]+)["']`, "i"));
    if (!match || Number(match[1]) !== Number(expected)) errors.push(`data-${name} 必须为 ${expected}`);
  }
  if (!html.includes("window.__timelines")) warnings.push("未发现 window.__timelines 注册，需确认时间线可被 HyperFrames 驱动");
  if (/Date\.now\(|Math\.random\(|setInterval\(/.test(html)) warnings.push("发现可能破坏确定性渲染的运行时代码");
  return { ok: errors.length === 0, errors, warnings, sourcePath };
}

function applySceneComments(projectRoot, sceneIds) {
  const path = join(projectRoot, PROJECT_FILES.revisions);
  const revisions = readJson(path, { schemaVersion: SCHEMA_VERSION, items: [] });
  let changed = false;
  for (const item of revisions.items) {
    if (sceneIds.includes(item.sceneId) && item.status === "open") {
      item.status = "applied";
      item.appliedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeJson(path, revisions);
}

function updateStoryboardStatuses(model, sceneIds, status) {
  for (const scene of model.storyboard.scenes) {
    if (sceneIds.includes(scene.id)) scene.status = status;
  }
  writeJson(join(model.root, PROJECT_FILES.storyboard), model.storyboard);
}

function selectedScenes(model, sceneId) {
  if (!sceneId) return model.storyboard.scenes;
  const scene = model.storyboard.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`找不到场景：${sceneId}`);
  return [scene];
}

export function buildScenes(projectRoot, options = {}) {
  compileProject(projectRoot);
  const model = loadProjectModel(projectRoot);
  const scenes = selectedScenes(model, options.sceneId);
  invalidateFrom(model.root, "scenes", options.sceneId || null);
  setStage(model.root, "scenes", "running", {
    inputHash: hashValue(scenes.map((scene) => ({ id: scene.id, duration: scene.duration }))),
  });
  const results = [];
  try {
    for (const scene of scenes) {
      const sceneProject = scaffoldSceneProject(model, scene);
      setSceneStage(model.root, scene.id, "running");
      if (options.mock) {
        writeText(join(sceneProject, "index.html"), buildMockSceneHtml(model, scene));
      }
      if (!options.mock && !options.accept) {
        setSceneStage(model.root, scene.id, "ready");
        results.push({ sceneId: scene.id, status: "ready", prompt: `scenes/${scene.id}/PROMPT.md` });
        continue;
      }
      const validation = validateSceneSource(model, scene);
      if (!validation.ok) throw new Error(`场景 ${scene.id} 校验失败：\n- ${validation.errors.join("\n- ")}`);
      const outputHash = hashFiles(model.root, [scene.src]);
      setSceneStage(model.root, scene.id, "complete", {
        outputHash,
        warnings: validation.warnings,
      });
      results.push({ sceneId: scene.id, status: "complete", outputHash, warnings: validation.warnings });
    }

    const completedIds = results.filter((item) => item.status === "complete").map((item) => item.sceneId);
    if (completedIds.length > 0) {
      updateStoryboardStatuses(model, completedIds, "animated");
      applySceneComments(model.root, completedIds);
    }
    compileProject(model.root);
    const state = loadState(model.root);
    const allComplete = model.storyboard.scenes.every(
      (scene) => state.sceneStates[scene.id]?.status === "complete",
    );
    setStage(model.root, "scenes", allComplete ? "complete" : "ready", {
      outputHash: hashValue(results),
    });
    return results;
  } catch (error) {
    for (const scene of scenes) {
      const state = loadState(model.root);
      if (state.sceneStates[scene.id]?.status === "running") {
        setSceneStage(model.root, scene.id, "failed", { error: error.message });
      }
    }
    setStage(model.root, "scenes", "failed", { error: error.message });
    throw error;
  }
}
