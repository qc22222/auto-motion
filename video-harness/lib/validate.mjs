import { existsSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_FILES, PROJECT_FILES, SCHEMA_VERSION, STAGES } from "./constants.mjs";
import { readJson } from "./fs-utils.mjs";
import { loadProjectModel, validateProjectModel } from "./model.mjs";
import { validateSceneSource } from "./scenes.mjs";
import { loadState } from "./state.mjs";

export function validateHarnessProject(projectRoot, options = {}) {
  const model = loadProjectModel(projectRoot);
  const base = validateProjectModel(model, { mockAudio: Boolean(options.mockAudio) });
  const errors = [...base.errors];
  const warnings = [...base.warnings];
  const state = loadState(model.root);
  if (state.schemaVersion !== SCHEMA_VERSION) errors.push(".harness/state.json schemaVersion 不受支持");
  for (const stage of STAGES) {
    if (!state.stages?.[stage]) errors.push(`状态文件缺少阶段：${stage}`);
  }
  for (const file of GENERATED_FILES) {
    if (!existsSync(join(model.root, file))) warnings.push(`尚未生成 ${file}，请执行 compile`);
  }
  for (const scene of model.storyboard.scenes) {
    const configPath = join(model.root, "scenes", scene.id, "scene.config.json");
    const planPath = join(model.root, "scenes", scene.id, "shot-plan.json");
    if (!existsSync(configPath)) warnings.push(`${scene.id} 尚未生成 scene.config.json`);
    if (!existsSync(planPath)) warnings.push(`${scene.id} 尚未生成 shot-plan.json`);
    if (state.sceneStates[scene.id]?.status === "complete") {
      const source = validateSceneSource(model, scene);
      errors.push(...source.errors.map((message) => `${scene.id}：${message}`));
      warnings.push(...source.warnings.map((message) => `${scene.id}：${message}`));
    }
  }

  const audioPath = join(model.root, PROJECT_FILES.audioMeta);
  if (existsSync(audioPath)) {
    const audio = readJson(audioPath);
    if (audio.mock && !options.mockAudio) {
      errors.push("生产校验不允许使用模拟音频；请生成真实 TTS，或仅在测试时使用 --mock-audio");
    }
    const voiceIds = new Set((audio.voices || []).map((voice) => voice.segmentId || voice.id));
    for (const segment of model.script.segments) {
      if (!voiceIds.has(segment.id)) errors.push(`audio_meta.json 缺少旁白：${segment.id}`);
    }
    if (!audio.narration?.path || !existsSync(join(model.root, audio.narration.path))) {
      errors.push("audio_meta.json 指向的完整旁白音轨不存在");
    }
  } else if (["complete", "approved"].includes(state.stages.audio.status)) {
    errors.push("音频阶段已完成，但 audio_meta.json 不存在");
  }

  if (["complete", "approved"].includes(state.stages.captions.status)) {
    for (const file of [PROJECT_FILES.captionGroups, PROJECT_FILES.captionsSrt, PROJECT_FILES.captionsVtt, PROJECT_FILES.captionsAss]) {
      if (!existsSync(join(model.root, file))) errors.push(`字幕阶段缺少产物：${file}`);
    }
  }
  if (["complete", "approved"].includes(state.stages.render.status)) {
    for (const scene of model.storyboard.scenes) {
      if (!existsSync(join(model.root, "renders", `${scene.id}.mp4`))) {
        errors.push(`渲染阶段缺少场景成片：${scene.id}.mp4`);
      }
    }
  }
  if (state.stages.delivery.status === "complete" && !existsSync(join(model.root, "delivery", "final.mp4"))) {
    errors.push("交付阶段已完成，但 delivery/final.mp4 不存在");
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    state,
    project: { id: model.project.id, title: model.project.title },
  };
}
