import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_APPROVALS,
  PROJECT_FILES,
  SAFE_ID_PATTERN,
  SCHEMA_VERSION,
} from "./constants.mjs";
import {
  ensureDir,
  nowIso,
  readJson,
  resolveInside,
  slugify,
  writeJson,
  writeText,
} from "./fs-utils.mjs";
import { createApprovals, createState } from "./state.mjs";
import { normalizeIndexTts2Settings } from "../../exampleFolder/.claude/skills/media-use/audio/scripts/lib/indextts2.mjs";

const DEFAULT_PALETTE = {
  canvas: "#F4F1DE",
  ink: "#222018",
  primary: "#E76F51",
  secondary: "#3D405B",
  accent: "#E9C46A",
};

export function projectRootFrom(path) {
  const root = resolve(path);
  if (!existsSync(join(root, PROJECT_FILES.project))) {
    throw new Error(`不是 Video Harness 项目：${root}`);
  }
  return root;
}

export function createProject(target, options = {}) {
  const root = resolve(target);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`目标目录已存在且非空：${root}`);
  }
  mkdirSync(root, { recursive: true });

  const title = options.title || basename(root);
  const id = options.id || slugify(title);
  const aspect = options.aspect || "9:16";
  const [width, height] = aspect === "3:4" ? [1080, 1440] : aspect === "16:9" ? [1920, 1080] : [1080, 1920];
  const now = nowIso();

  const project = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    workflow: {
      mode: options.mode || "review",
      destination: options.destination || "short-video",
      language: options.language || "zh-CN",
      message: options.message || "请填写这条视频唯一要传达的信息",
      audience: options.audience || "中文互联网用户",
      approvals: options.mode === "automation" ? ["review"] : [...DEFAULT_APPROVALS],
    },
    render: {
      width,
      height,
      fps: 30,
      videoCodec: "libx264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      burnCaptions: true,
    },
    audio: {
      tts: {
        cache: true,
      },
      mastering: {
        narrationLufs: -16,
        mixLufs: -14,
        truePeakDb: -1,
        loudnessRangeLu: 11,
        ducking: {
          enabled: true,
          threshold: 0.03,
          ratio: 6,
          attackMs: 20,
          releaseMs: 350,
        },
      },
      bgm: {
        mode: "none",
        query: "",
        volume: 0.12,
      },
    },
    paths: {
      scenes: "scenes",
      reviews: "reviews",
      renders: "renders",
      delivery: "delivery",
    },
  };

  const script = {
    schemaVersion: SCHEMA_VERSION,
    title,
    segments: [
      {
        id: "line-001",
        sceneId: "scene-001",
        label: "开场",
        text: options.initialText || "请在 script.json 中填写最终确认的旁白文案。",
        delivery: "自然、清晰、有节奏",
        pauseAfter: 0.25,
        locked: false,
      },
    ],
  };

  const voice = {
    schemaVersion: SCHEMA_VERSION,
    provider: "heygen",
    voiceId: "",
    cloneRequired: true,
    referenceAudio: "",
    referenceAudioAuthorized: false,
    language: options.language || "zh-CN",
    speed: 1,
    direction: "保持本人自然语气，清晰、克制、有亲和力",
    settings: {},
    pronunciations: {},
  };

  const design = {
    schemaVersion: SCHEMA_VERSION,
    concept: "清晰、有设计感、避免模板化 UI 堆叠",
    palette: DEFAULT_PALETTE,
    typography: {
      display: "Microsoft YaHei UI",
      body: "Microsoft YaHei",
      heroPx: 112,
      titlePx: 72,
      bodyPx: 38,
      labelPx: 24,
    },
    layout: {
      safeMarginX: Math.round(width * 0.07),
      safeMarginY: Math.round(height * 0.06),
      captionBandRatio: 0.17,
      maxSimultaneousElements: 6,
    },
    motion: {
      defaultEase: "power3.out",
      transitionSeconds: 0.55,
      finalHoldSeconds: 1,
      intensity: "medium",
    },
    captions: {
      enabled: true,
      maxChars: 14,
      position: "bottom",
      background: "rgba(34,32,24,0.78)",
      activeColor: "#E9C46A",
    },
    avoid: ["无理由使用终端窗口", "过小文字", "无意义装饰", "全片重复同一种卡片布局"],
  };

  const storyboard = {
    schemaVersion: SCHEMA_VERSION,
    message: project.workflow.message,
    arc: "Hook → Explain → Land",
    audience: project.workflow.audience,
    scenes: [
      {
        id: "scene-001",
        index: 1,
        title: "开场",
        scriptIds: ["line-001"],
        duration: null,
        transitionIn: "cut",
        status: "outline",
        summary: "根据确认文案设计开场镜头",
        focal: "待规划",
        blueprint: "compose",
        poster: 0.5,
        src: "scenes/scene-001/project/index.html",
      },
    ],
  };

  for (const dir of [
    ".harness/logs",
    ".harness/prompts",
    ".harness/audio-temp",
    "assets/reference",
    "assets/voice",
    "captions",
    "compositions",
    "reviews",
    "renders",
    "delivery",
    "scenes/scene-001",
  ]) {
    ensureDir(join(root, dir));
  }

  writeJson(join(root, PROJECT_FILES.project), project);
  writeJson(join(root, PROJECT_FILES.script), script);
  writeJson(join(root, PROJECT_FILES.voice), voice);
  writeJson(join(root, PROJECT_FILES.design), design);
  writeJson(join(root, PROJECT_FILES.storyboard), storyboard);
  writeJson(join(root, PROJECT_FILES.state), createState(project.workflow.mode));
  writeJson(join(root, PROJECT_FILES.approvals), createApprovals(project.workflow.approvals));
  writeJson(join(root, PROJECT_FILES.revisions), {
    schemaVersion: SCHEMA_VERSION,
    items: [],
  });
  writeJson(join(root, PROJECT_FILES.captionOverrides), {
    schemaVersion: SCHEMA_VERSION,
    items: [],
  });
  writeText(
    join(root, ".env.example"),
    [
      "# 真实克隆音色凭据只写入 .env，不要提交到版本库。",
      "HEYGEN_API_KEY=",
      "ELEVENLABS_API_KEY=",
      "# IndexTTS2 默认使用工作区 .codex/runtime 与 .codex/models，无需全局配置。",
      "INDEXTTS2_ROOT=",
      "INDEXTTS2_MODEL_DIR=",
      "HYPERFRAMES_WHISPER_PATH=",
    ].join("\n"),
  );
  writeText(
    join(root, ".gitignore"),
    [
      ".env",
      ".harness/logs/",
      "assets/reference/",
      "assets/voice/",
      "renders/",
      "delivery/",
    ].join("\n"),
  );

  return root;
}

export function loadProjectModel(projectRoot) {
  const root = projectRootFrom(projectRoot);
  return {
    root,
    project: readJson(join(root, PROJECT_FILES.project)),
    script: readJson(join(root, PROJECT_FILES.script)),
    voice: readJson(join(root, PROJECT_FILES.voice)),
    design: readJson(join(root, PROJECT_FILES.design)),
    storyboard: readJson(join(root, PROJECT_FILES.storyboard)),
  };
}

export function validateProjectModel(model, options = {}) {
  const errors = [];
  const warnings = [];
  const { project, script, voice, design, storyboard } = model;

  if (project.schemaVersion !== SCHEMA_VERSION) errors.push("project.json schemaVersion 不受支持");
  if (!project.id || !project.title) errors.push("project.json 缺少 id 或 title");
  if (project.id && !SAFE_ID_PATTERN.test(project.id)) errors.push("project.json id 只能使用字母、数字、点、下划线和短横线");
  if (!Number.isFinite(project.render?.width) || !Number.isFinite(project.render?.height)) {
    errors.push("project.json render.width/height 无效");
  }
  if (!Number.isFinite(project.render?.fps) || project.render.fps <= 0) {
    errors.push("project.json render.fps 无效");
  }

  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    errors.push("script.json 至少需要一个旁白段落");
  }
  const segmentIds = new Set();
  for (const segment of script.segments || []) {
    if (!segment.id || !segment.sceneId || !String(segment.text || "").trim()) {
      errors.push("script.json 中每个段落必须有 id、sceneId 和 text");
      continue;
    }
    if (segment.id && !SAFE_ID_PATTERN.test(segment.id)) errors.push(`旁白段落 id 不安全：${segment.id}`);
    if (segment.sceneId && !SAFE_ID_PATTERN.test(segment.sceneId)) errors.push(`旁白场景 id 不安全：${segment.sceneId}`);
    if (segmentIds.has(segment.id)) errors.push(`script.json 段落 id 重复：${segment.id}`);
    segmentIds.add(segment.id);
    if (segment.text.includes("请在 script.json 中填写")) warnings.push("旁白仍是初始化占位文案");
  }

  if (!voice.provider || !["heygen", "elevenlabs", "kokoro", "indextts2"].includes(voice.provider)) {
    errors.push("voice-profile.json provider 仅支持 heygen、elevenlabs、kokoro、indextts2");
  }
  if (voice.cloneRequired && voice.provider !== "indextts2" && !voice.voiceId && !options.mockAudio) {
    errors.push("已要求克隆音色，但 voice-profile.json 尚未填写 voiceId");
  }
  const speed = Number(voice.speed);
  const speedMin = voice.provider === "elevenlabs" ? 0.7 : 0.5;
  const speedMax = voice.provider === "elevenlabs" ? 1.2 : 2;
  if (!Number.isFinite(speed) || speed < speedMin || speed > speedMax) {
    errors.push(`voice-profile.json speed 必须在 ${speedMin} 到 ${speedMax} 之间`);
  }
  if (voice.provider === "kokoro" && voice.cloneRequired) {
    errors.push("Kokoro 只提供本地预置音色，不支持 cloneRequired；如需克隆音色请使用 HeyGen 或 ElevenLabs");
  }
  if (voice.provider === "kokoro" && !String(voice.voiceId || "").trim()) {
    errors.push("Kokoro 必须明确填写 voiceId；中文可使用 zf_xiaobei");
  }
  if (voice.provider === "indextts2") {
    const referenceAudio = String(voice.referenceAudio || "").trim();
    if (voice.cloneRequired !== true) {
      errors.push("IndexTTS2 必须启用 cloneRequired，并使用本人或已授权的参考音频");
    }
    if (!referenceAudio) {
      errors.push("IndexTTS2 必须填写项目相对路径 referenceAudio");
    } else if (isAbsolute(referenceAudio)) {
      errors.push("IndexTTS2 referenceAudio 必须使用项目相对路径");
    } else {
      try {
        resolveInside(model.root, referenceAudio);
      } catch (error) {
        errors.push(`IndexTTS2 referenceAudio 无效：${error.message}`);
      }
    }
    if (voice.referenceAudioAuthorized !== true) {
      errors.push("IndexTTS2 参考音频授权必须明确确认为 true");
    }
    try {
      normalizeIndexTts2Settings(voice.settings || {});
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (voice.provider === "elevenlabs") {
    const settings = voice.settings;
    if (settings == null || typeof settings !== "object" || Array.isArray(settings)) {
      errors.push("ElevenLabs settings 必须是对象");
    } else {
      const allowedSettings = new Set([
        "stability",
        "similarityBoost",
        "similarity_boost",
        "style",
        "useSpeakerBoost",
        "use_speaker_boost",
      ]);
      const unknownSettings = Object.keys(settings).filter((key) => !allowedSettings.has(key));
      if (unknownSettings.length > 0) {
        errors.push(`ElevenLabs settings 包含不支持字段：${unknownSettings.join("、")}`);
      }
      for (const key of ["stability", "similarityBoost", "similarity_boost", "style"]) {
        if (settings[key] == null) continue;
        const value = Number(settings[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          errors.push(`ElevenLabs settings.${key} 必须在 0 到 1 之间`);
        }
      }
      for (const key of ["useSpeakerBoost", "use_speaker_boost"]) {
        if (settings[key] != null && typeof settings[key] !== "boolean") {
          errors.push(`ElevenLabs settings.${key} 必须是布尔值`);
        }
      }
    }
    const dictionaries = voice.pronunciations?.dictionaries;
    if (dictionaries != null && !Array.isArray(dictionaries)) {
      errors.push("ElevenLabs pronunciations.dictionaries 必须是数组");
    } else {
      for (const [index, entry] of (dictionaries || []).entries()) {
        if (typeof entry === "string") {
          const separator = entry.indexOf(":");
          if (separator <= 0 || separator === entry.length - 1) {
            errors.push(`ElevenLabs 发音词典第 ${index + 1} 项必须使用 dictionaryId:versionId`);
          }
          continue;
        }
        const dictionaryId = entry?.id ?? entry?.pronunciation_dictionary_id;
        const versionId = entry?.versionId ?? entry?.version_id;
        if (!String(dictionaryId || "").trim() || !String(versionId || "").trim()) {
          errors.push(`ElevenLabs 发音词典第 ${index + 1} 项缺少 id 或 versionId`);
        }
      }
    }
  }
  const bgmMode = project.audio?.bgm?.mode || "none";
  if (project.audio?.tts?.cache != null && typeof project.audio.tts.cache !== "boolean") {
    errors.push("project.json audio.tts.cache 必须是布尔值");
  }
  const mastering = project.audio?.mastering;
  if (mastering != null && (typeof mastering !== "object" || Array.isArray(mastering))) {
    errors.push("project.json audio.mastering 必须是对象");
  } else if (mastering) {
    const checkRange = (path, value, min, max) => {
      const number = Number(value);
      if (!Number.isFinite(number) || number < min || number > max) {
        errors.push(`project.json audio.mastering.${path} 必须在 ${min} 到 ${max} 之间`);
      }
    };
    checkRange("narrationLufs", mastering.narrationLufs, -24, -12);
    checkRange("mixLufs", mastering.mixLufs, -24, -10);
    checkRange("truePeakDb", mastering.truePeakDb, -6, -0.1);
    checkRange("loudnessRangeLu", mastering.loudnessRangeLu, 1, 20);
    if (typeof mastering.ducking?.enabled !== "boolean") {
      errors.push("project.json audio.mastering.ducking.enabled 必须是布尔值");
    }
    checkRange("ducking.threshold", mastering.ducking?.threshold, 0.0001, 1);
    checkRange("ducking.ratio", mastering.ducking?.ratio, 1, 20);
    checkRange("ducking.attackMs", mastering.ducking?.attackMs, 0.01, 2000);
    checkRange("ducking.releaseMs", mastering.ducking?.releaseMs, 1, 9000);
  }
  if (!["none", "retrieve", "generate"].includes(bgmMode)) {
    errors.push("project.json audio.bgm.mode 仅支持 none、retrieve 或 generate");
  }
  if (!design.palette?.canvas || !design.palette?.ink || !design.palette?.primary) {
    errors.push("design.json 缺少 canvas、ink 或 primary 颜色角色");
  }

  const sceneIds = new Set();
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    errors.push("storyboard.json 至少需要一个场景");
  }
  for (const scene of storyboard.scenes || []) {
    if (!scene.id) errors.push("storyboard.json 存在缺少 id 的场景");
    if (scene.id && !SAFE_ID_PATTERN.test(scene.id)) errors.push(`storyboard.json 场景 id 不安全：${scene.id}`);
    if (sceneIds.has(scene.id)) errors.push(`storyboard.json 场景 id 重复：${scene.id}`);
    sceneIds.add(scene.id);
    for (const scriptId of scene.scriptIds || []) {
      if (!segmentIds.has(scriptId)) errors.push(`场景 ${scene.id} 引用了不存在的旁白：${scriptId}`);
    }
  }
  for (const segment of script.segments || []) {
    if (!sceneIds.has(segment.sceneId)) warnings.push(`旁白 ${segment.id} 的 sceneId 尚未出现在 storyboard.json`);
  }

  return { errors, warnings, ok: errors.length === 0 };
}
