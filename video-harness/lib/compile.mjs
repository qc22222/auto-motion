import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FILES, SCHEMA_VERSION } from "./constants.mjs";
import {
  hashFiles,
  hashValue,
  nowIso,
  readJson,
  writeJson,
  writeText,
} from "./fs-utils.mjs";
import { loadProjectModel, validateProjectModel } from "./model.mjs";
import {
  invalidateFrom,
  isApproved,
  loadState,
  setSceneStage,
  setStage,
} from "./state.mjs";
import { estimateSpeech, formatSeconds, round3 } from "./timing.mjs";

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function segmentTiming(segment, audioBySegment, voice) {
  const audio = audioBySegment.get(segment.id);
  if (audio) {
    return {
      duration: Number(audio.duration_s) || 0,
      timelineDuration:
        Number(audio.timeline_duration_s) ||
        round3((Number(audio.duration_s) || 0) + (Number(segment.pauseAfter) || 0)),
      source: "audio",
    };
  }
  const estimated = estimateSpeech(segment.text, {
    speed: voice.speed,
    language: voice.language,
  });
  return {
    duration: estimated.duration,
    timelineDuration: round3(estimated.duration + (Number(segment.pauseAfter) || 0)),
    source: "estimate",
  };
}

function normalizeStoryboard(model, audioMeta) {
  const { script, storyboard, voice } = model;
  const existing = new Map((storyboard.scenes || []).map((scene) => [scene.id, scene]));
  const scriptSceneIds = [];
  for (const segment of script.segments) {
    if (!scriptSceneIds.includes(segment.sceneId)) scriptSceneIds.push(segment.sceneId);
  }
  const orderedIds = [
    ...scriptSceneIds,
    ...(storyboard.scenes || []).map((scene) => scene.id).filter((id) => !scriptSceneIds.includes(id)),
  ];
  const audioBySegment = new Map(
    (audioMeta?.voices || []).map((voiceItem) => [voiceItem.segmentId || voiceItem.id, voiceItem]),
  );
  const schedule = [];
  let projectCursor = 0;

  storyboard.scenes = orderedIds.map((sceneId, sceneIndex) => {
    const previous = existing.get(sceneId) || {};
    const segments = script.segments.filter((segment) => segment.sceneId === sceneId);
    let sceneCursor = 0;
    let durationSource = "manual";
    for (const segment of segments) {
      const timing = segmentTiming(segment, audioBySegment, voice);
      durationSource = timing.source;
      schedule.push({
        segment,
        sceneId,
        frame: sceneIndex + 1,
        sceneStart: round3(sceneCursor),
        projectStart: round3(projectCursor + sceneCursor),
        duration: timing.duration,
        timelineDuration: timing.timelineDuration,
      });
      sceneCursor += timing.timelineDuration;
    }
    const extraHold = Math.max(0, Number(previous.extraHold) || 0);
    const scriptedDuration = round3(sceneCursor + extraHold);
    const duration = segments.length > 0
      ? Math.max(0.3, scriptedDuration)
      : Math.max(0.3, Number(previous.duration) || 3);
    const scene = {
      ...previous,
      id: sceneId,
      index: sceneIndex + 1,
      title: previous.title || segments[0]?.label || `场景 ${sceneIndex + 1}`,
      scriptIds: segments.map((segment) => segment.id),
      duration: round3(duration),
      durationSource,
      transitionIn: previous.transitionIn || (sceneIndex === 0 ? "cut" : "crossfade"),
      status: previous.status || "outline",
      summary: previous.summary || `围绕“${segments.map((segment) => segment.text).join(" ")}”建立单一视觉重点`,
      focal: previous.focal || "由场景规划确定",
      blueprint: previous.blueprint || "compose",
      poster: Number.isFinite(Number(previous.poster))
        ? Number(previous.poster)
        : round3(Math.min(Math.max(duration * 0.5, 0.2), Math.max(duration - 0.1, 0.2))),
      src: previous.src || `scenes/${sceneId}/project/index.html`,
      extraHold,
    };
    projectCursor += duration;
    return scene;
  });
  storyboard.message = model.project.workflow.message;
  storyboard.audience = model.project.workflow.audience;
  storyboard.totalDuration = round3(projectCursor);
  return schedule;
}

function buildBrief(model) {
  const { project, storyboard } = model;
  const mode = project.workflow.mode === "automation" ? "automation" : "companion";
  return `---
workflow: video-harness
flow: ${mode}
storyboard: yes
message: ${yamlString(project.workflow.message)}
destination: ${project.workflow.destination}
aspect: ${project.render.width}x${project.render.height}
language: ${project.workflow.language}
length: ${formatSeconds(storyboard.totalDuration || 0)}
audience: ${yamlString(project.workflow.audience)}
---

# ${project.title}

## Intent

面向${project.workflow.audience}，用一条可审阅、可局部返工的视频清晰传达：${project.workflow.message}

## Assets

- \`assets/\` — 项目本地图片、视频、字体和品牌素材。
- \`assets/voice/\` — 分段配音与最终旁白音轨。

## Customizations

- 文案、音色、设计规范、分镜和场景配置都以 JSON 文件为可编辑事实来源。
- 字幕由字词时间戳自动生成，场景时长由真实音频驱动。
- 审阅意见按场景记录，只返工被点名的场景。

## Notes

- 运行模式：${project.workflow.mode}
- 默认字幕烧录：${project.render.burnCaptions ? "是" : "否"}
`;
}

function buildScript(model, schedule) {
  const { project, voice } = model;
  const voiceName = voice.voiceId || "尚未填写 voiceId";
  const settings = Object.entries(voice.settings || {})
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ") || `speed ${voice.speed}`;
  const lines = [
    `# SCRIPT — ${project.id}`,
    "",
    `**Voice:** ${voiceName} (${voice.provider})`,
    `**Voice settings:** ${settings}`,
    `**Voice direction:** ${voice.direction}`,
    "",
    "---",
  ];
  for (let index = 0; index < schedule.length; index++) {
    const item = schedule[index];
    const end = round3(item.projectStart + item.duration);
    lines.push(
      "",
      `## Line ${index + 1} — ${item.segment.label || item.segment.id} (Frame ${item.frame})`,
      "",
      `**Time:** ${item.projectStart} – ${end}s`,
      `**Delivery:** ${item.segment.delivery || voice.direction}`,
      "",
      `    ${item.segment.text}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildFrame(model) {
  const { design } = model;
  const paletteLines = Object.entries(design.palette || {}).map(
    ([key, value]) => `  ${key}: ${yamlString(value)}`,
  );
  const typography = design.typography || {};
  return `# Frame Design — ${model.project.title}

colors:
${paletteLines.join("\n")}

typography:
  display: { fontFamily: ${yamlString(typography.display)}, fontSize: ${typography.heroPx || 112}, fontWeight: 700 }
  headline: { fontFamily: ${yamlString(typography.display)}, fontSize: ${typography.titlePx || 72}, fontWeight: 700 }
  body: { fontFamily: ${yamlString(typography.body)}, fontSize: ${typography.bodyPx || 38}, fontWeight: 500 }
  label: { fontFamily: ${yamlString(typography.body)}, fontSize: ${typography.labelPx || 24}, fontWeight: 600 }

layout:
  safeMarginX: ${design.layout?.safeMarginX}
  safeMarginY: ${design.layout?.safeMarginY}
  captionBandRatio: ${design.layout?.captionBandRatio}
  maxSimultaneousElements: ${design.layout?.maxSimultaneousElements}

motion:
  defaultEase: ${design.motion?.defaultEase}
  transitionSeconds: ${design.motion?.transitionSeconds}
  finalHoldSeconds: ${design.motion?.finalHoldSeconds}
  intensity: ${design.motion?.intensity}

captions:
  enabled: ${design.captions?.enabled !== false}
  maxChars: ${design.captions?.maxChars || 14}
  position: ${design.captions?.position || "bottom"}
  background: ${yamlString(design.captions?.background || "rgba(0,0,0,0.72)")}
  activeColor: ${yamlString(design.captions?.activeColor || design.palette?.accent)}

concept: ${yamlString(design.concept)}

avoid:
${(design.avoid || []).map((item) => `  - ${yamlString(item)}`).join("\n")}
`;
}

function sceneVoiceover(scene, script) {
  return scene.scriptIds
    .map((id) => script.segments.find((segment) => segment.id === id)?.text)
    .filter(Boolean)
    .join(" ");
}

function buildStoryboard(model) {
  const { project, script, storyboard } = model;
  const lines = [
    "---",
    `format: ${project.render.width}x${project.render.height}`,
    `duration: ${formatSeconds(storyboard.totalDuration || 0)}`,
    `message: ${yamlString(project.workflow.message)}`,
    `arc: ${storyboard.arc}`,
    `audience: ${yamlString(project.workflow.audience)}`,
    `mode: ${project.workflow.mode === "automation" ? "autonomous" : "collaborative"}`,
    `music: ${project.audio?.bgm?.mode === "none" ? "none" : yamlString(project.audio?.bgm?.query || "")}`,
    "---",
  ];
  for (const scene of storyboard.scenes) {
    lines.push(
      "",
      `## Frame ${scene.index} — ${scene.title}`,
      "",
      `- scene: ${scene.summary}`,
      `- duration: ${formatSeconds(scene.duration)}`,
      `- poster: ${formatSeconds(scene.poster)}`,
      `- transition_in: ${scene.transitionIn}`,
      `- status: ${scene.status}`,
      `- voiceover: ${yamlString(sceneVoiceover(scene, script))}`,
      `- src: ${scene.src}`,
      `- scene_id: ${scene.id}`,
      `- focal: ${scene.focal}`,
      `- blueprint: ${scene.blueprint}`,
      "",
      scene.summary,
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildAudioRequest(model) {
  const { project, script, voice } = model;
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: voice.provider,
    voice: voice.voiceId,
    referenceAudio: voice.referenceAudio || "",
    referenceAudioAuthorized: voice.referenceAudioAuthorized === true,
    lang: voice.language,
    speed: voice.speed,
    direction: voice.direction,
    settings: voice.settings || {},
    pronunciations: voice.pronunciations || {},
    tts: {
      cache: project.audio?.tts?.cache !== false,
    },
    lines: script.segments.map((segment) => ({
      id: segment.id,
      sceneId: segment.sceneId,
      text: segment.text,
      delivery: segment.delivery,
      pauseAfter: Number(segment.pauseAfter) || 0,
    })),
    bgm: project.audio?.bgm || { mode: "none" },
  };
}

function buildScenePrompt(model, scene, shotPlan, revisions) {
  const openComments = revisions.items.filter(
    (item) => item.sceneId === scene.id && item.status === "open",
  );
  return `# 场景制作任务：${scene.id}

请在当前场景目录内完成一个可由 HyperFrames 独立检查和渲染的场景工程。

## 输入

- 镜头标题：${scene.title}
- 时长：${scene.duration} 秒
- 画布：${model.project.render.width} × ${model.project.render.height}
- 帧率：${model.project.render.fps}fps
- 旁白：${shotPlan.narration || "无旁白"}
- 核心信息：${model.project.workflow.message}
- 视觉重点：${scene.focal}
- 场景摘要：${scene.summary}

## 必须读取

- \`../../BRIEF.md\`
- \`../../frame.md\`
- \`../../STORYBOARD.md\`
- \`./shot-plan.json\`
- \`./scene.config.json\`

## 制作要求

1. 只修改本场景的 \`project/\`，不要改动其他场景。
2. 保持时长、画布和帧率与 \`scene.config.json\` 完全一致。
3. 使用大字号、明确层级和单一视觉焦点，避免模板化卡片堆叠。
4. 动画必须可按任意时间点确定性求值；禁止使用运行时随机数、系统时钟和无限动画。
5. 字幕由总装阶段统一处理，场景画面不要重复烧录完整旁白。
6. 完成后运行本地 \`hyperframes-local.ps1 lint\` 与 \`check\`。

## 本轮审阅意见

${openComments.length > 0 ? openComments.map((item) => `- ${item.text}`).join("\n") : "- 暂无。"}

## 验收输出

- \`project/index.html\`
- 通过 HyperFrames lint/check
- 如执行渲染：\`../../renders/${scene.id}.mp4\`
`;
}

function writeSceneArtifacts(model, scene, schedule, revisions) {
  const root = model.root;
  const sceneRoot = join(root, "scenes", scene.id);
  const previousPlan = readJson(join(sceneRoot, "shot-plan.json"), {});
  const previousConfig = readJson(join(sceneRoot, "scene.config.json"), {});
  const segments = schedule.filter((item) => item.sceneId === scene.id);
  const narration = segments.map((item) => item.segment.text).join(" ");
  const shotPlan = {
    schemaVersion: SCHEMA_VERSION,
    sceneId: scene.id,
    title: scene.title,
    purpose: scene.summary,
    narration,
    segmentIds: scene.scriptIds,
    duration: scene.duration,
    transitionIn: scene.transitionIn,
    focal: scene.focal,
    blueprint: scene.blueprint,
    visualPlan: previousPlan.visualPlan || {
      opening: "建立场景语义和视觉焦点",
      development: "用一到两个视觉动作解释旁白",
      landing: "稳定落在本场景结论并衔接下一场",
    },
    onScreenText: previousPlan.onScreenText || [],
    assets: previousPlan.assets || [],
    sfx: previousPlan.sfx || [],
    manualNotes: previousPlan.manualNotes || "",
    updatedAt: nowIso(),
  };
  const sceneInput = { ...scene };
  delete sceneInput.status;
  delete sceneInput.durationSource;
  const inputHash = hashValue({
    project: {
      message: model.project.workflow.message,
      render: model.project.render,
    },
    design: model.design,
    scene: sceneInput,
    shotPlan: {
      visualPlan: shotPlan.visualPlan,
      onScreenText: shotPlan.onScreenText,
      assets: shotPlan.assets,
      sfx: shotPlan.sfx,
      manualNotes: shotPlan.manualNotes,
    },
  });
  const config = {
    schemaVersion: SCHEMA_VERSION,
    sceneId: scene.id,
    inputHash,
    render: {
      width: model.project.render.width,
      height: model.project.render.height,
      fps: model.project.render.fps,
      duration: scene.duration,
      output: `../../renders/${scene.id}.mp4`,
      ...(previousConfig.renderOverrides || {}),
    },
    source: "project/index.html",
    builder: previousConfig.builder || { mode: "external", command: null },
    renderOverrides: previousConfig.renderOverrides || {},
    updatedAt: nowIso(),
  };
  const state = loadState(root);
  const previousScene = state.sceneStates[scene.id];
  // 生成中的场景(running)与失败场景(failed)不被 compile 的 inputHash 检测误标 stale：
  // 并行生成时,一个场景完成触发的 compileProject 不能覆盖其他正在生成/已失败的场景。
  if (previousScene && ["running", "failed"].includes(previousScene.status)) return inputHash;
  const previousHash = previousScene?.inputHash;
  if (previousHash && previousHash !== inputHash) setSceneStage(root, scene.id, "stale", { inputHash });
  else if (!previousScene) setSceneStage(root, scene.id, "ready", { inputHash });
  writeJson(join(sceneRoot, "shot-plan.json"), shotPlan);
  writeJson(join(sceneRoot, "scene.config.json"), config);
  writeText(join(sceneRoot, "PROMPT.md"), buildScenePrompt(model, scene, shotPlan, revisions));
  return inputHash;
}

function maybeInvalidate(projectRoot, stage, nextHash, options = {}) {
  if ((options.suppressAutomaticInvalidationStages || []).includes(stage)) return;
  const state = loadState(projectRoot);
  const previousHash = state.stages[stage]?.inputHash;
  if (previousHash && previousHash !== nextHash) invalidateFrom(projectRoot, stage);
}

export function compileProject(projectRoot, options = {}) {
  const model = loadProjectModel(projectRoot);
  const validation = validateProjectModel(model, { mockAudio: true });
  if (!validation.ok) throw new Error(`项目模型校验失败：\n- ${validation.errors.join("\n- ")}`);

  const audioMeta = existsSync(join(model.root, PROJECT_FILES.audioMeta))
    ? readJson(join(model.root, PROJECT_FILES.audioMeta))
    : null;
  const scriptHash = hashValue(model.script);
  const designHash = hashValue(model.design);
  maybeInvalidate(model.root, "script", scriptHash, options);
  maybeInvalidate(model.root, "design", designHash, options);

  const schedule = normalizeStoryboard(model, audioMeta);
  const storyboardHash = hashValue({
    ...model.storyboard,
    scenes: model.storyboard.scenes.map(({ status: _status, durationSource: _source, ...scene }) => scene),
  });
  maybeInvalidate(model.root, "storyboard", storyboardHash, options);
  writeJson(join(model.root, PROJECT_FILES.storyboard), model.storyboard);

  const revisions = readJson(join(model.root, PROJECT_FILES.revisions), {
    schemaVersion: SCHEMA_VERSION,
    items: [],
  });
  writeText(join(model.root, "BRIEF.md"), buildBrief(model));
  writeText(join(model.root, "SCRIPT.md"), buildScript(model, schedule));
  writeText(join(model.root, "frame.md"), buildFrame(model));
  writeText(join(model.root, "STORYBOARD.md"), buildStoryboard(model));
  writeJson(join(model.root, PROJECT_FILES.audioRequest), buildAudioRequest(model));
  const sceneHashes = Object.fromEntries(
    model.storyboard.scenes.map((scene) => [
      scene.id,
      writeSceneArtifacts(model, scene, schedule, revisions),
    ]),
  );

  const outputHash = hashFiles(model.root, [
    "BRIEF.md",
    "SCRIPT.md",
    "frame.md",
    "STORYBOARD.md",
    PROJECT_FILES.audioRequest,
  ]);
  const reviewMode = model.project.workflow.mode !== "automation";
  setStage(model.root, "script", isApproved(model.root, "script") ? "approved" : reviewMode ? "needs_approval" : "complete", {
    inputHash: scriptHash,
    outputHash,
  });
  setStage(model.root, "design", "complete", { inputHash: designHash, outputHash });
  const latestState = loadState(model.root);
  const audioReady = audioMeta && ["complete", "approved"].includes(latestState.stages.audio?.status);
  const storyboardStatus = isApproved(model.root, "storyboard") && audioReady
    ? "approved"
    : audioReady
      ? reviewMode
        ? options.requestStoryboardApproval
          ? "needs_approval"
          : "ready"
        : "complete"
      : "pending";
  setStage(model.root, "storyboard", storyboardStatus, {
    inputHash: storyboardHash,
    outputHash,
  });

  return {
    projectRoot: model.root,
    scenes: model.storyboard.scenes.length,
    segments: model.script.segments.length,
    totalDuration: model.storyboard.totalDuration,
    durationSource: audioMeta ? (audioMeta.mock ? "mock-audio" : "audio") : "estimate",
    warnings: validation.warnings,
    sceneHashes,
    outputHash,
  };
}
