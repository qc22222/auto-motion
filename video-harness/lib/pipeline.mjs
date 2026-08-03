import { existsSync } from "node:fs";
import { join } from "node:path";
import { assembleProject } from "./assemble.mjs";
import { generateAudio } from "./audio.mjs";
import { generateCaptions } from "./captions.mjs";
import { compileProject } from "./compile.mjs";
import { PROJECT_FILES } from "./constants.mjs";
import { readJson } from "./fs-utils.mjs";
import { generateScenes } from "./generator.mjs";
import { loadProjectModel } from "./model.mjs";
import { renderScenes } from "./render.mjs";
import { generateReview } from "./review.mjs";
import { isApproved, loadApprovals, loadState } from "./state.mjs";
import { validateHarnessProject } from "./validate.mjs";

function stageComplete(projectRoot, stage) {
  return ["complete", "approved"].includes(loadState(projectRoot).stages[stage]?.status);
}

function waitsForApproval(projectRoot, stage) {
  const state = loadState(projectRoot);
  if (state.mode === "automation" && stage !== "review") return false;
  const approvals = loadApprovals(projectRoot);
  return approvals.required.includes(stage) && !isApproved(projectRoot, stage);
}

function gate(stage, actions) {
  return {
    status: "waiting_approval",
    stage,
    actions,
    message: `流水线已推进到 ${stage} 质量门，请审阅并执行 approve ${stage} 后再次运行 advance`,
  };
}

export async function advanceProject(projectRoot, options = {}) {
  const actions = [];
  compileProject(projectRoot);
  actions.push("compile");
  if (waitsForApproval(projectRoot, "script")) return gate("script", actions);

  const audioPath = join(projectRoot, PROJECT_FILES.audioMeta);
  const audioMeta = existsSync(audioPath) ? readJson(audioPath) : null;
  const needsRealAudio = !options.mockAudio && audioMeta?.mock;
  if (!stageComplete(projectRoot, "audio") || needsRealAudio) {
    generateAudio(projectRoot, {
      mock: Boolean(options.mockAudio),
      engine: options.audioEngine,
    });
    actions.push(options.mockAudio ? "audio:mock" : "audio:real");
  }

  compileProject(projectRoot, { requestStoryboardApproval: true });
  actions.push("plan");
  if (waitsForApproval(projectRoot, "storyboard")) return gate("storyboard", actions);

  if (!stageComplete(projectRoot, "captions")) {
    generateCaptions(projectRoot);
    actions.push("captions");
  }

  let model = loadProjectModel(projectRoot);
  let state = loadState(projectRoot);
  const scenesToGenerate = model.storyboard.scenes.filter(
    (scene) => state.sceneStates[scene.id]?.status !== "complete",
  );
  for (const scene of scenesToGenerate) {
    await generateScenes(projectRoot, {
      sceneId: scene.id,
      runner: options.runner,
      model: options.model,
      timeoutMs: options.timeoutMs,
      echo: options.echo,
    });
    actions.push(`generate:${scene.id}`);
  }

  generateReview(projectRoot);
  actions.push("review");
  if (waitsForApproval(projectRoot, "review")) return gate("review", actions);

  if (!stageComplete(projectRoot, "render")) {
    model = loadProjectModel(projectRoot);
    for (const scene of model.storyboard.scenes) {
      const outputPath = join(model.root, "renders", `${scene.id}.mp4`);
      renderScenes(projectRoot, {
        sceneId: scene.id,
        mock: Boolean(options.mockRender),
        accept: !options.mockRender && existsSync(outputPath),
        quality: options.quality,
        timeoutMs: options.timeoutMs,
      });
      actions.push(`render:${scene.id}`);
    }
  }

  let delivery = null;
  if (!stageComplete(projectRoot, "delivery")) {
    delivery = assembleProject(projectRoot, {
      allowMockAudio: Boolean(options.allowMockAudio),
    });
    actions.push("assemble");
  }

  const validation = validateHarnessProject(projectRoot, {
    mockAudio: Boolean(options.mockAudio),
  });
  if (!validation.ok) {
    throw new Error(`流水线完成校验失败：\n- ${validation.errors.join("\n- ")}`);
  }
  state = loadState(projectRoot);
  return {
    status: "complete",
    actions,
    delivery: delivery?.path || join(projectRoot, "delivery", "final.mp4"),
    state,
    validation,
  };
}
