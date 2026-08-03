import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { buildScenes } from "./scenes.mjs";
import { ensureDir, hashValue, nowIso, writeJson } from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import { setSceneStage, setStage } from "./state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..");
const WORKSPACE_ROOT = resolve(HARNESS_ROOT, "..");
const DEFAULT_RUNNER = join(HARNESS_ROOT, "scripts", "claude-scene-runner.mjs");
const SHARED_TEMPLATE_ROOT = join(WORKSPACE_ROOT, "exampleFolder");

function selectedScenes(model, sceneId) {
  if (!sceneId) return model.storyboard.scenes;
  const scene = model.storyboard.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`找不到场景：${sceneId}`);
  return [scene];
}

function runRunner(runner, requestPath, sceneRoot, options = {}) {
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 7_200_000);
  const stdoutPath = join(options.projectRoot, ".harness", "logs", `${options.sceneId}-generator.stdout.log`);
  const stderrPath = join(options.projectRoot, ".harness", "logs", `${options.sceneId}-generator.stderr.log`);
  ensureDir(dirname(stdoutPath));

  return new Promise((resolveRun, rejectRun) => {
    const stdoutLog = createWriteStream(stdoutPath, { encoding: "utf8" });
    const stderrLog = createWriteStream(stderrPath, { encoding: "utf8" });
    let stderrTail = "";
    let timedOut = false;
    const child = spawn(process.execPath, [runner, "--request", requestPath], {
      cwd: sceneRoot,
      env: {
        ...process.env,
        VIDEO_HARNESS_WORKSPACE: WORKSPACE_ROOT,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      stdoutLog.write(chunk);
      if (options.echo !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrLog.write(chunk);
      stderrTail = `${stderrTail}${text}`.slice(-8_000);
      if (options.echo !== false) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", async (error) => {
      clearTimeout(timer);
      stdoutLog.end();
      stderrLog.end();
      await Promise.allSettled([finished(stdoutLog), finished(stderrLog)]);
      rejectRun(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      stdoutLog.end();
      stderrLog.end();
      await Promise.allSettled([finished(stdoutLog), finished(stderrLog)]);
      if (timedOut) {
        rejectRun(new Error(`场景 ${options.sceneId} 生成超时（${timeoutMs}ms）`));
        return;
      }
      if (code !== 0) {
        rejectRun(
          new Error(
            `场景 ${options.sceneId} 生成器失败（退出码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}）${stderrTail.trim() ? `：${stderrTail.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolveRun({ stdoutPath, stderrPath });
    });
  });
}

export async function generateScenes(projectRoot, options = {}) {
  const runner = resolve(options.runner || process.env.VIDEO_HARNESS_SCENE_RUNNER || DEFAULT_RUNNER);
  if (!existsSync(runner)) throw new Error(`找不到场景生成器：${runner}`);

  // build 的默认分支只准备工程和任务单，不会改变原黑箱的创作方式。
  buildScenes(projectRoot, { sceneId: options.sceneId });
  const model = loadProjectModel(projectRoot);
  const scenes = selectedScenes(model, options.sceneId);
  const results = [];

  for (const scene of scenes) {
    const sceneRoot = join(model.root, "scenes", scene.id);
    const request = {
      schemaVersion: 1,
      generatedAt: nowIso(),
      projectRoot: model.root,
      sceneRoot,
      sceneId: scene.id,
      promptPath: join(sceneRoot, "PROMPT.md"),
      projectDir: join(sceneRoot, "project"),
      outputSource: join(model.root, scene.src),
      outputRender: join(model.root, "renders", `${scene.id}.mp4`),
      sharedTemplateRoot: SHARED_TEMPLATE_ROOT,
      width: model.project.render.width,
      height: model.project.render.height,
      fps: model.project.render.fps,
      duration: scene.duration,
      model: options.model || null,
    };
    const requestPath = join(model.root, ".harness", "scene-builder", `${scene.id}.request.json`);
    writeJson(requestPath, request);
    const inputHash = hashValue({ ...request, generatedAt: null });
    setSceneStage(model.root, scene.id, "running", {
      inputHash,
      generator: { runner, request: requestPath, startedAt: nowIso() },
    });

    try {
      const logs = await runRunner(runner, requestPath, sceneRoot, {
        projectRoot: model.root,
        sceneId: scene.id,
        timeoutMs: options.timeoutMs,
        echo: options.echo,
      });
      const accepted = buildScenes(model.root, { sceneId: scene.id, accept: true })[0];
      const generator = {
        runner,
        request: requestPath,
        stdout: logs.stdoutPath,
        stderr: logs.stderrPath,
        completedAt: nowIso(),
      };
      setSceneStage(model.root, scene.id, "complete", { generator });
      results.push({ ...accepted, generator });
    } catch (error) {
      setSceneStage(model.root, scene.id, "failed", { error: error.message });
      setStage(model.root, "scenes", "failed", { error: error.message });
      throw error;
    }
  }

  return results;
}
