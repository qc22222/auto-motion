import { join } from "node:path";
import { compileProject } from "./compile.mjs";
import { DEFAULT_APPROVALS, PROJECT_FILES, SCHEMA_VERSION, STAGES } from "./constants.mjs";
import { setCaptionOverride } from "./captions.mjs";
import { appendJsonLine, hashValue, nowIso, readJson, writeJson } from "./fs-utils.mjs";
import { loadProjectModel, validateProjectModel } from "./model.mjs";
import { invalidateStages, loadApprovals, loadState } from "./state.mjs";
import { normalizeMasteringConfig } from "./audio-mastering.mjs";

const FULL_NARRATION_IMPACT = [
  "script",
  "audio",
  "storyboard",
  "scenes",
  "captions",
  "review",
  "render",
  "delivery",
];
const AUDIO_IMPACT = ["audio", "storyboard", "scenes", "captions", "review", "render", "delivery"];
const BGM_IMPACT = ["audio", "delivery"];
const DELIVERY_AUDIO_IMPACT = ["delivery"];
const STORYBOARD_VISUAL_IMPACT = ["storyboard", "scenes", "review", "render", "delivery"];
const SCENE_IMPACT = ["scenes", "review", "render", "delivery"];
const CAPTION_IMPACT = ["captions", "review", "render", "delivery"];
const DESIGN_VISUAL_IMPACT = ["design", "scenes", "review", "render", "delivery"];
const DESIGN_WITH_CAPTIONS_IMPACT = ["design", "scenes", "captions", "review", "render", "delivery"];

function field(name, label, type, impact, options = {}) {
  return { name, label, type, impact: { stages: impact }, ...options };
}

const SECTIONS = [
  {
    target: "project",
    title: "项目意图与画布",
    description: "修改视频要传达什么、给谁看，以及最终画布规格。",
    singletonId: "project",
    fields: [
      field("workflow.message", "核心信息", "textarea", STORYBOARD_VISUAL_IMPACT, { required: true, maxLength: 1000 }),
      field("workflow.audience", "目标受众", "text", STORYBOARD_VISUAL_IMPACT, { required: true, maxLength: 300 }),
      field("workflow.destination", "发布场景", "text", STORYBOARD_VISUAL_IMPACT, { required: true, maxLength: 100 }),
      field("render.width", "画布宽度", "number", ["scenes", "captions", "review", "render", "delivery"], { min: 160, max: 7680, step: 2 }),
      field("render.height", "画布高度", "number", ["scenes", "captions", "review", "render", "delivery"], { min: 160, max: 7680, step: 2 }),
      field("render.fps", "帧率", "number", ["scenes", "captions", "review", "render", "delivery"], { min: 12, max: 120, step: 1 }),
    ],
  },
  {
    target: "script",
    title: "旁白文案",
    description: "逐段修改说什么、怎么说、停顿多久。文本与节奏变更会重新生成完整旁白。",
    fields: [
      field("label", "段落名称", "text", ["script"], { required: true, maxLength: 120 }),
      field("text", "旁白文本", "textarea", FULL_NARRATION_IMPACT, { required: true, maxLength: 5000 }),
      field("delivery", "演绎要求", "textarea", FULL_NARRATION_IMPACT, {
        maxLength: 1000,
        help: "逐段演绎说明会写入音频任务契约；IndexTTS2 的 delivery 情绪模式会逐段消费，其他提供方会在预检中说明支持边界。",
      }),
      field("pauseAfter", "段后停顿（秒）", "number", FULL_NARRATION_IMPACT, { min: 0, max: 10, step: 0.05 }),
      field("sceneId", "所属场景", "select", FULL_NARRATION_IMPACT, { required: true }),
      field("locked", "锁定本段", "boolean", [], { help: "锁定只控制后续可编辑性，不触发重新生成。" }),
    ],
  },
  {
    target: "voice",
    title: "音色与演绎",
    description: "修改 TTS 提供方、克隆音色、语速和全局演绎方向。",
    singletonId: "voice",
    fields: [
      field("provider", "语音提供方", "select", AUDIO_IMPACT, {
        required: true,
        help: "IndexTTS2 使用本机 NVIDIA GPU 和已授权参考音频；HeyGen/ElevenLabs 使用远程音色；Kokoro 只支持本地预置音色。",
        options: [
          { value: "heygen", label: "HeyGen" },
          { value: "elevenlabs", label: "ElevenLabs" },
          { value: "kokoro", label: "Kokoro" },
          { value: "indextts2", label: "IndexTTS2（本地 GPU）" },
        ],
      }),
      field("voiceId", "音色 ID", "text", AUDIO_IMPACT, {
        maxLength: 300,
        appliesToProviders: ["heygen", "elevenlabs", "kokoro"],
        help: "必须填写所选提供方真实存在的音色标识；Kokoro 中文预置音色示例：zf_xiaobei。",
      }),
      field("cloneRequired", "必须使用克隆音色", "boolean", AUDIO_IMPACT, {
        help: "IndexTTS2 必须开启并使用已授权参考音频；Kokoro 不支持克隆音色。",
      }),
      field("referenceAudio", "参考音频路径", "text", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        required: true,
        maxLength: 500,
        help: "仅 IndexTTS2 生效。填写项目内相对路径，例如 assets/reference/owner.wav；建议使用清晰、单人、少噪声的短音频。",
      }),
      field("referenceAudioAuthorized", "确认拥有参考音频授权", "boolean", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        help: "必须明确勾选；未授权或未确认时生产预检会阻断。",
      }),
      field("language", "语言", "text", AUDIO_IMPACT, {
        required: true,
        maxLength: 40,
        help: "项目使用 BCP 47 写法（如 zh-CN）；调用本地引擎时会转换为其支持的 zh。",
      }),
      field("speed", "语速倍率", "number", AUDIO_IMPACT, {
        min: 0.5,
        max: 2,
        step: 0.05,
        providerConstraints: {
          heygen: { min: 0.5, max: 2 },
          elevenlabs: { min: 0.7, max: 1.2 },
          kokoro: { min: 0.5, max: 2 },
          indextts2: { min: 0.5, max: 2 },
        },
        help: "IndexTTS2 公共版本不提供精确时长控制，因此在合成后用 FFmpeg 调整语速；ElevenLabs 官方范围为 0.7–1.2。",
      }),
      field("settings.emotionMode", "IndexTTS2 情绪控制模式", "select", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        options: [
          { value: "none", label: "不额外控制" },
          { value: "delivery", label: "逐段演绎要求" },
          { value: "text", label: "统一情绪文本" },
          { value: "vector", label: "八维情绪向量" },
          { value: "audio", label: "情绪参考音频" },
        ],
        help: "推荐逐段演绎要求：每一段可独立修改 delivery，并只重生成受影响的音频段。",
      }),
      field("settings.emotionText", "统一情绪文本", "textarea", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        maxLength: 1000,
        help: "仅 emotionMode=text 时生效，例如：沉稳、真诚、略带期待。",
      }),
      field("settings.emotionVector", "八维情绪向量", "text", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        maxLength: 200,
        help: "仅 emotionMode=vector 时生效；填写 8 个 0–1 数值并用逗号分隔，总和不得超过 0.8。",
      }),
      field("settings.emotionAudio", "情绪参考音频路径", "text", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        maxLength: 500,
        help: "仅 emotionMode=audio 时生效；必须是项目内相对路径，且同样需要合法授权。",
      }),
      field("settings.emotionWeight", "情绪控制权重", "number", AUDIO_IMPACT, {
        appliesToProviders: ["indextts2"],
        min: 0,
        max: 1,
        step: 0.05,
        help: "IndexTTS2 情绪控制强度，默认 0.6；先用短句试听再调整。",
      }),
      field("settings.stability", "稳定度", "number", AUDIO_IMPACT, {
        min: 0,
        max: 1,
        step: 0.05,
        appliesToProviders: ["elevenlabs"],
        help: "仅 ElevenLabs 生效。较低更有变化，较高更稳定；建议先用短句试听。",
      }),
      field("settings.similarityBoost", "音色相似度", "number", AUDIO_IMPACT, {
        min: 0,
        max: 1,
        step: 0.05,
        appliesToProviders: ["elevenlabs"],
        help: "仅 ElevenLabs 生效。过高可能放大原始音色中的噪声或瑕疵。",
      }),
      field("settings.style", "风格强度", "number", AUDIO_IMPACT, {
        min: 0,
        max: 1,
        step: 0.05,
        appliesToProviders: ["elevenlabs"],
        help: "仅 ElevenLabs 生效。提高风格会增加表现力，也可能降低稳定性。",
      }),
      field("settings.useSpeakerBoost", "增强说话人相似度", "boolean", AUDIO_IMPACT, {
        appliesToProviders: ["elevenlabs"],
        help: "仅 ElevenLabs 生效；关闭可减少额外计算，是否更自然需以试听为准。",
      }),
      field("pronunciations.dictionaries", "发音词典（每行一项）", "string-list", AUDIO_IMPACT, {
        appliesToProviders: ["elevenlabs"],
        maxItems: 10,
        maxLength: 300,
        help: "仅 ElevenLabs 生效。每行填写 dictionaryId:versionId，用于人名、品牌名和专业术语。",
      }),
      field("direction", "全局演绎方向", "textarea", AUDIO_IMPACT, {
        maxLength: 1000,
        help: "会写入音频任务契约；IndexTTS2 的 delivery 模式会把它作为全局基调并与逐段演绎要求合并。",
      }),
    ],
  },
  {
    target: "storyboard",
    title: "分镜参数",
    description: "逐镜头调整叙事目的、视觉焦点、转场和停留；时长仍由真实音频驱动。",
    fields: [
      field("title", "镜头标题", "text", STORYBOARD_VISUAL_IMPACT, { required: true, maxLength: 160 }),
      field("summary", "镜头目的", "textarea", STORYBOARD_VISUAL_IMPACT, { required: true, maxLength: 1200 }),
      field("focal", "视觉焦点", "text", STORYBOARD_VISUAL_IMPACT, { required: true, maxLength: 300 }),
      field("blueprint", "构图蓝图", "select", STORYBOARD_VISUAL_IMPACT, {
        options: ["compose", "diagram", "comparison", "timeline", "map", "quote", "data"].map((value) => ({ value, label: value })),
      }),
      field("transitionIn", "入场转场", "select", STORYBOARD_VISUAL_IMPACT, {
        options: ["cut", "crossfade", "fade", "wipe", "push", "zoom"].map((value) => ({ value, label: value })),
      }),
      field("poster", "审阅海报时刻（秒）", "number", STORYBOARD_VISUAL_IMPACT, { min: 0, max: 3600, step: 0.05 }),
      field("extraHold", "额外停留（秒）", "number", AUDIO_IMPACT, {
        min: 0,
        max: 30,
        step: 0.05,
        help: "这会改变完整旁白中的静音段及后续字幕时间轴，因此影响范围大于普通分镜参数。",
      }),
    ],
  },
  {
    target: "design",
    title: "全局设计规范",
    description: "修改色彩、字体、布局、动效和字幕规范。全局设计会影响所有镜头。",
    singletonId: "design",
    fields: [
      field("concept", "设计概念", "textarea", DESIGN_VISUAL_IMPACT, { required: true, maxLength: 1200 }),
      ...["canvas", "ink", "primary", "secondary", "accent"].map((name) =>
        field(`palette.${name}`, `颜色 · ${name}`, "color", DESIGN_WITH_CAPTIONS_IMPACT, { required: true }),
      ),
      field("typography.display", "展示字体", "text", DESIGN_WITH_CAPTIONS_IMPACT, { required: true, maxLength: 200 }),
      field("typography.body", "正文字体", "text", DESIGN_WITH_CAPTIONS_IMPACT, { required: true, maxLength: 200 }),
      ...[
        ["heroPx", "主视觉字号"],
        ["titlePx", "标题字号"],
        ["bodyPx", "正文字号"],
        ["labelPx", "标签字号"],
      ].map(([name, label]) => field(`typography.${name}`, label, "number", DESIGN_WITH_CAPTIONS_IMPACT, { min: 8, max: 500, step: 1 })),
      field("layout.safeMarginX", "水平安全边距", "number", DESIGN_WITH_CAPTIONS_IMPACT, { min: 0, max: 2000, step: 1 }),
      field("layout.safeMarginY", "垂直安全边距", "number", DESIGN_WITH_CAPTIONS_IMPACT, { min: 0, max: 2000, step: 1 }),
      field("layout.captionBandRatio", "字幕带高度比例", "number", DESIGN_WITH_CAPTIONS_IMPACT, { min: 0.05, max: 0.5, step: 0.01 }),
      field("layout.maxSimultaneousElements", "同时可见元素上限", "number", DESIGN_VISUAL_IMPACT, { min: 1, max: 30, step: 1 }),
      field("motion.defaultEase", "默认缓动", "text", DESIGN_VISUAL_IMPACT, { required: true, maxLength: 80 }),
      field("motion.transitionSeconds", "默认转场时长", "number", DESIGN_VISUAL_IMPACT, { min: 0, max: 5, step: 0.05 }),
      field("motion.finalHoldSeconds", "结尾停留", "number", DESIGN_VISUAL_IMPACT, { min: 0, max: 10, step: 0.05 }),
      field("motion.intensity", "动效强度", "select", DESIGN_VISUAL_IMPACT, {
        options: ["low", "medium", "high"].map((value) => ({ value, label: value })),
      }),
      field("captions.enabled", "启用字幕", "boolean", DESIGN_WITH_CAPTIONS_IMPACT),
      field("captions.maxChars", "单组字幕最大字数", "number", DESIGN_WITH_CAPTIONS_IMPACT, { min: 6, max: 60, step: 1 }),
      field("captions.position", "字幕位置", "select", DESIGN_WITH_CAPTIONS_IMPACT, {
        options: ["bottom", "center", "top"].map((value) => ({ value, label: value })),
      }),
      field("captions.background", "字幕背景", "text", DESIGN_WITH_CAPTIONS_IMPACT, { required: true, maxLength: 120 }),
      field("captions.activeColor", "逐字高亮色", "color", DESIGN_WITH_CAPTIONS_IMPACT, { required: true }),
      field("avoid", "明确避免项（每行一项）", "string-list", DESIGN_VISUAL_IMPACT, { maxItems: 50, maxLength: 300 }),
    ],
  },
  {
    target: "scene",
    title: "单镜头画面",
    description: "只修改选中镜头的画面计划、屏幕文字、素材和手工备注。",
    fields: [
      field("visualPlan.opening", "开场动作", "textarea", SCENE_IMPACT, { required: true, maxLength: 1200 }),
      field("visualPlan.development", "发展动作", "textarea", SCENE_IMPACT, { required: true, maxLength: 1200 }),
      field("visualPlan.landing", "落点动作", "textarea", SCENE_IMPACT, { required: true, maxLength: 1200 }),
      field("onScreenText", "屏幕文字（每行一项）", "string-list", SCENE_IMPACT, { maxItems: 50, maxLength: 500 }),
      field("assets", "素材引用（每行一项）", "string-list", SCENE_IMPACT, { maxItems: 100, maxLength: 500 }),
      field("sfx", "音效提示（每行一项）", "string-list", SCENE_IMPACT, { maxItems: 50, maxLength: 500 }),
      field("manualNotes", "画面修改说明", "textarea", SCENE_IMPACT, { maxLength: 5000 }),
    ],
  },
  {
    target: "caption",
    title: "逐条字幕",
    description: "修改单条字幕文本、时间、显隐和局部样式，不重做音频或镜头。",
    fields: [
      field("text", "字幕文本", "textarea", CAPTION_IMPACT, { required: true, maxLength: 1000 }),
      field("start", "开始时间（秒）", "number", CAPTION_IMPACT, { min: 0, max: 86400, step: 0.01 }),
      field("end", "结束时间（秒）", "number", CAPTION_IMPACT, { min: 0, max: 86400, step: 0.01 }),
      field("hidden", "隐藏该字幕", "boolean", CAPTION_IMPACT),
      field("style.offsetX", "水平偏移", "number", CAPTION_IMPACT, { min: -4000, max: 4000, step: 1 }),
      field("style.offsetY", "垂直偏移", "number", CAPTION_IMPACT, { min: -4000, max: 4000, step: 1 }),
      field("style.fontSize", "字号", "number", CAPTION_IMPACT, { min: 8, max: 500, step: 1 }),
      field("style.background", "局部背景", "text", CAPTION_IMPACT, { maxLength: 120 }),
      field("style.color", "局部文字色", "color", CAPTION_IMPACT),
      field("style.maxWidth", "最大宽度", "text", CAPTION_IMPACT, { maxLength: 80 }),
    ],
  },
  {
    target: "delivery",
    title: "声音混合与交付",
    description: "控制背景音乐请求和最终是否烧录字幕。两者的重算范围不同。",
    singletonId: "delivery",
    fields: [
      field("tts.cache", "复用未变化的分段配音", "boolean", [], {
        help: "开启后按旁白段落、音色、语速和发音参数精确复用；关闭只影响下次执行，不会自动重做现有音频。需要重新抽样时使用“强制重生成”。",
      }),
      field("bgm.mode", "背景音乐模式", "select", BGM_IMPACT, {
        options: ["none", "retrieve", "generate"].map((value) => ({ value, label: value })),
      }),
      field("bgm.query", "背景音乐描述", "text", BGM_IMPACT, {
        maxLength: 1000,
        help: "retrieve 用于检索关键词，generate 用于生成提示词；none 模式会忽略此字段。",
      }),
      field("bgm.volume", "背景音乐基础音量", "number", DELIVERY_AUDIO_IMPACT, {
        min: 0,
        max: 1,
        step: 0.01,
        help: "只影响最终混音，不重新生成 BGM、旁白、字幕或画面。旁白出现时还会按侧链参数自动压低音乐。",
      }),
      field("mastering.narrationLufs", "纯旁白目标响度（LUFS）", "number", DELIVERY_AUDIO_IMPACT, {
        min: -24,
        max: -12,
        step: 0.5,
        help: "无 BGM 时的目标综合响度；默认 -16 LUFS。",
      }),
      field("mastering.mixLufs", "最终混音目标响度（LUFS）", "number", DELIVERY_AUDIO_IMPACT, {
        min: -24,
        max: -10,
        step: 0.5,
        help: "带 BGM 时的最终目标综合响度；短视频默认 -14 LUFS。",
      }),
      field("mastering.truePeakDb", "真峰值上限（dBTP）", "number", DELIVERY_AUDIO_IMPACT, {
        min: -6,
        max: -0.1,
        step: 0.1,
        help: "限制编码前峰值，默认 -1 dBTP，降低 AAC 编码后削波风险。",
      }),
      field("mastering.ducking.enabled", "旁白出现时压低 BGM", "boolean", DELIVERY_AUDIO_IMPACT),
      field("mastering.ducking.threshold", "侧链触发阈值", "number", DELIVERY_AUDIO_IMPACT, {
        min: 0.0001,
        max: 1,
        step: 0.005,
      }),
      field("mastering.ducking.ratio", "侧链压缩比", "number", DELIVERY_AUDIO_IMPACT, {
        min: 1,
        max: 20,
        step: 0.5,
      }),
      field("mastering.ducking.attackMs", "BGM 压低响应（毫秒）", "number", DELIVERY_AUDIO_IMPACT, {
        min: 0.01,
        max: 2000,
        step: 1,
      }),
      field("mastering.ducking.releaseMs", "BGM 恢复时间（毫秒）", "number", DELIVERY_AUDIO_IMPACT, {
        min: 1,
        max: 9000,
        step: 10,
      }),
      field("burnCaptions", "成片烧录字幕", "boolean", ["delivery"]),
    ],
  },
];

function clone(value) {
  return structuredClone(value);
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function setPath(value, path, next) {
  const keys = path.split(".");
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys.at(-1)] = next;
}

function valuesFor(source, fields) {
  return Object.fromEntries(fields.map((item) => [item.name, clone(getPath(source, item.name))]));
}

function sectionFor(target) {
  const section = SECTIONS.find((item) => item.target === target);
  if (!section) throw new Error(`未知修改环节：${target}`);
  return section;
}

function normalizeBoolean(value, label) {
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "是"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "否"].includes(String(value).toLowerCase())) return false;
  throw new Error(`${label} 必须是布尔值`);
}

function normalizeFieldValue(definition, rawValue) {
  let value;
  if (definition.type === "boolean") {
    value = normalizeBoolean(rawValue, definition.label);
  } else if (definition.type === "number") {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`${definition.label} 必须是有效数字`);
    if (definition.min != null && value < definition.min) throw new Error(`${definition.label} 不能小于 ${definition.min}`);
    if (definition.max != null && value > definition.max) throw new Error(`${definition.label} 不能大于 ${definition.max}`);
  } else if (definition.type === "string-list") {
    const items = Array.isArray(rawValue) ? rawValue : String(rawValue ?? "").split(/\r?\n/u);
    value = items.map((item) => String(item).trim()).filter(Boolean);
    if (definition.maxItems != null && value.length > definition.maxItems) {
      throw new Error(`${definition.label} 最多允许 ${definition.maxItems} 项`);
    }
    if (definition.maxLength != null && value.some((item) => [...item].length > definition.maxLength)) {
      throw new Error(`${definition.label} 中存在超过 ${definition.maxLength} 字的项目`);
    }
  } else {
    value = String(rawValue ?? "").trim();
    if (definition.required && !value) throw new Error(`${definition.label} 不能为空`);
    if (definition.maxLength != null && [...value].length > definition.maxLength) {
      throw new Error(`${definition.label} 不能超过 ${definition.maxLength} 字`);
    }
    if (definition.type === "color" && value && !/^(?:#[0-9a-f]{3,8}|rgba?\([^)]*\))$/iu.test(value)) {
      throw new Error(`${definition.label} 必须是十六进制或 rgb/rgba 颜色`);
    }
    if (definition.type === "select" && definition.options?.length > 0) {
      const allowed = definition.options.map((item) => item.value);
      if (!allowed.includes(value)) throw new Error(`${definition.label} 不支持值：${value}`);
    }
  }
  return value;
}

function readCaptionItems(root) {
  const payload = readJson(join(root, PROJECT_FILES.captionGroups), { groups: [] });
  const overrides = readJson(join(root, PROJECT_FILES.captionOverrides), { items: [] });
  const overrideItems = Array.isArray(overrides) ? overrides : overrides.items || [];
  const byId = new Map(overrideItems.map((item) => [item.captionId || item.id, item]));
  const baseById = new Map((payload.groups || []).map((item) => [item.id, item]));
  for (const [id, override] of byId) {
    if (!baseById.has(id)) baseById.set(id, { id, text: override.text || id, start: override.start || 0, end: override.end || 0 });
  }
  return [...baseById.values()].map((base) => {
    const override = byId.get(base.id) || {};
    const value = {
      text: override.text ?? base.text,
      start: override.start ?? base.start,
      end: override.end ?? base.end,
      hidden: override.hidden ?? false,
      style: clone(override.style || base.style || {}),
    };
    return { id: base.id, label: `${base.id} · ${value.text}`, values: value };
  });
}

function buildSections(root, model) {
  const sceneOptions = model.storyboard.scenes.map((scene) => ({ value: scene.id, label: `${scene.id} · ${scene.title}` }));
  return SECTIONS.map((definition) => {
    const fields = definition.fields.map((item) => item.name === "sceneId" ? { ...item, options: sceneOptions } : clone(item));
    let items;
    switch (definition.target) {
      case "project":
        items = [{ id: "project", label: model.project.title, values: valuesFor(model.project, fields) }];
        break;
      case "script":
        items = model.script.segments.map((segment) => ({
          id: segment.id,
          label: `${segment.id} · ${segment.label || segment.text.slice(0, 18)}`,
          values: valuesFor(segment, fields),
          meta: { sceneId: segment.sceneId, locked: Boolean(segment.locked) },
        }));
        break;
      case "voice":
        items = [{ id: "voice", label: `${model.voice.provider} · ${model.voice.voiceId || "未选择音色"}`, values: valuesFor(model.voice, fields) }];
        break;
      case "storyboard":
        items = model.storyboard.scenes.map((scene) => ({
          id: scene.id,
          label: `${scene.id} · ${scene.title}`,
          values: valuesFor(scene, fields),
          meta: { duration: scene.duration, scriptIds: scene.scriptIds },
        }));
        break;
      case "design":
        items = [{ id: "design", label: "全局设计", values: valuesFor(model.design, fields) }];
        break;
      case "scene":
        items = model.storyboard.scenes.map((scene) => {
          const plan = readJson(join(root, "scenes", scene.id, "shot-plan.json"), {
            visualPlan: { opening: "", development: "", landing: "" },
            onScreenText: [],
            assets: [],
            sfx: [],
            manualNotes: "",
          });
          return { id: scene.id, label: `${scene.id} · ${scene.title}`, values: valuesFor(plan, fields), meta: { duration: scene.duration } };
        });
        break;
      case "caption":
        items = readCaptionItems(root).map((item) => ({ ...item, values: valuesFor(item.values, fields) }));
        break;
      case "delivery": {
        const delivery = {
          burnCaptions: model.project.render.burnCaptions,
          tts: model.project.audio?.tts || { cache: true },
          mastering: normalizeMasteringConfig(model.project.audio?.mastering),
          bgm: model.project.audio?.bgm || { mode: "none", query: "", volume: 0.12 },
        };
        items = [{ id: "delivery", label: "声音混合与最终交付", values: valuesFor(delivery, fields) }];
        break;
      }
      default:
        throw new Error(`未实现修改环节：${definition.target}`);
    }
    return {
      target: definition.target,
      title: definition.title,
      description: definition.description,
      fields,
      items,
    };
  });
}

export function getEditCatalog(projectRoot) {
  const model = loadProjectModel(projectRoot);
  return {
    schemaVersion: SCHEMA_VERSION,
    project: { id: model.project.id, title: model.project.title },
    generatedAt: nowIso(),
    sections: buildSections(model.root, model),
  };
}

function sourceSnapshot(root, target, id, model) {
  switch (target) {
    case "project": return model.project;
    case "script": return model.script;
    case "voice": return model.voice;
    case "storyboard": return model.storyboard;
    case "design": return model.design;
    case "scene": return {
      storyboard: model.storyboard.scenes.find((scene) => scene.id === id),
      plan: readJson(join(root, "scenes", id, "shot-plan.json"), {}),
    };
    case "caption": return {
      groups: readJson(join(root, PROJECT_FILES.captionGroups), { groups: [] }),
      overrides: readJson(join(root, PROJECT_FILES.captionOverrides), { items: [] }),
    };
    case "delivery": return { render: model.project.render, audio: model.project.audio };
    default: throw new Error(`未知修改环节：${target}`);
  }
}

function orderedStages(values) {
  const set = new Set(values);
  return STAGES.filter((stage) => set.has(stage));
}

function impactFor(section, changedFields, id, approvals) {
  const stages = orderedStages(changedFields.flatMap((name) => section.fields.find((item) => item.name === name).impact.stages));
  const affectsScenes = stages.includes("scenes");
  const sceneScope = affectsScenes
    ? ["storyboard", "scene"].includes(section.target) ? "selected" : "all"
    : "none";
  const sceneIds = sceneScope === "selected" ? [id] : [];
  const approvalsCleared = DEFAULT_APPROVALS.filter((stage) => stages.includes(stage) && approvals.required.includes(stage));
  const summary = [];
  if (stages.includes("audio")) summary.push("需要重新生成完整旁白与时间戳");
  if (sceneScope === "all") summary.push("所有镜头需要重新生成或重新验收");
  if (sceneScope === "selected") summary.push(`只返工镜头 ${id}`);
  if (stages.includes("captions")) summary.push("需要重新生成字幕产物");
  if (approvalsCleared.length > 0) summary.push(`撤销审批：${approvalsCleared.join("、")}`);
  if (stages.length === 0) summary.push("仅更新编辑控制信息，不触发生成任务");
  return { stages, sceneScope, sceneIds, approvalsCleared, summary };
}

function assertCompositeRules(model, target, id, nextValues) {
  if (target === "script") {
    const segment = model.script.segments.find((item) => item.id === id);
    if (segment.locked && !(Object.keys(nextValues).length === 1 && nextValues.locked === false)) {
      throw new Error(`旁白 ${id} 已锁定，请先单独取消锁定`);
    }
    if (nextValues.sceneId && !model.storyboard.scenes.some((scene) => scene.id === nextValues.sceneId)) {
      throw new Error(`所属场景不存在：${nextValues.sceneId}`);
    }
  }
  if (target === "storyboard") {
    const scene = model.storyboard.scenes.find((item) => item.id === id);
    const baseDuration = Math.max(0.3, Number(scene.duration) - (Number(scene.extraHold) || 0));
    const currentExtraHold = Number(scene.extraHold) || 0;
    const futureDuration = baseDuration + (nextValues.extraHold ?? currentExtraHold);
    if (nextValues.poster != null && nextValues.poster > futureDuration) {
      throw new Error(`审阅海报时刻不能超过修改后的镜头时长 ${futureDuration}s`);
    }
  }
  if (target === "caption") {
    const item = readCaptionItems(model.root).find((caption) => caption.id === id);
    const start = nextValues.start ?? item.values.start;
    const end = nextValues.end ?? item.values.end;
    if (end <= start) throw new Error("字幕结束时间必须晚于开始时间");
    if (nextValues.hidden !== true && !(nextValues.text ?? item.values.text).trim()) throw new Error("可见字幕文本不能为空");
  }
  if (target === "project") {
    const width = nextValues["render.width"] ?? model.project.render.width;
    const height = nextValues["render.height"] ?? model.project.render.height;
    if (width * height > 33_177_600) throw new Error("画布像素总量过大，不能超过 8K 级别");
  }
}

function prepareEdit(projectRoot, request) {
  const model = loadProjectModel(projectRoot);
  const section = sectionFor(String(request?.target || ""));
  const sections = buildSections(model.root, model);
  const currentSection = sections.find((item) => item.target === section.target);
  const id = String(request?.id || section.singletonId || "").trim();
  const item = currentSection.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`修改目标不存在：${section.target}/${id || "<empty>"}`);
  if (!request?.changes || typeof request.changes !== "object" || Array.isArray(request.changes)) {
    throw new Error("修改请求必须提供 changes 对象");
  }
  const requestedFields = Object.keys(request.changes);
  if (requestedFields.length === 0) throw new Error("至少需要修改一个字段");
  const byName = new Map(currentSection.fields.map((definition) => [definition.name, definition]));
  const unsupported = requestedFields.filter((name) => !byName.has(name));
  if (unsupported.length > 0) throw new Error(`不支持修改字段：${unsupported.join("、")}`);
  const normalized = Object.fromEntries(
    requestedFields.map((name) => [name, normalizeFieldValue(byName.get(name), request.changes[name])]),
  );
  assertCompositeRules(model, section.target, id, normalized);
  const changed = Object.fromEntries(
    Object.entries(normalized).filter(([name, value]) =>
      hashValue({ value }) !== hashValue({ value: item.values[name] }),
    ),
  );
  const changedFields = Object.keys(changed);
  const approvals = loadApprovals(model.root);
  const impact = impactFor(currentSection, changedFields, id, approvals);
  const sourceHash = hashValue(sourceSnapshot(model.root, section.target, id, model));
  const fingerprint = hashValue({ target: section.target, id, changes: changed, sourceHash });
  return { model, section: currentSection, id, item, changed, changedFields, impact, sourceHash, fingerprint };
}

export function previewProjectEdit(projectRoot, request) {
  const prepared = prepareEdit(projectRoot, request);
  return {
    schemaVersion: SCHEMA_VERSION,
    target: prepared.section.target,
    id: prepared.id,
    changed: prepared.changedFields.length > 0,
    changedFields: prepared.changedFields,
    normalizedChanges: prepared.changed,
    impact: prepared.impact,
    fingerprint: prepared.fingerprint,
  };
}

function validateDraft(model) {
  const validation = validateProjectModel(model, { mockAudio: true });
  if (!validation.ok) throw new Error(`修改后项目模型无效：\n- ${validation.errors.join("\n- ")}`);
}

function writeModelEdit(prepared) {
  const { model, section, id, changed } = prepared;
  const target = section.target;
  if (["project", "script", "voice", "storyboard", "design", "delivery"].includes(target)) {
    const draft = clone(model);
    let destination;
    if (target === "project") destination = draft.project;
    else if (target === "script") destination = draft.script.segments.find((item) => item.id === id);
    else if (target === "voice") destination = draft.voice;
    else if (target === "storyboard") destination = draft.storyboard.scenes.find((item) => item.id === id);
    else if (target === "design") destination = draft.design;
    else destination = {
      burnCaptions: draft.project.render.burnCaptions,
      tts: clone(draft.project.audio?.tts || { cache: true }),
      mastering: normalizeMasteringConfig(draft.project.audio?.mastering),
      bgm: clone(draft.project.audio?.bgm || {}),
    };
    for (const [path, value] of Object.entries(changed)) setPath(destination, path, value);
    if (target === "delivery") {
      draft.project.render.burnCaptions = destination.burnCaptions;
      draft.project.audio = draft.project.audio || {};
      draft.project.audio.tts = destination.tts;
      draft.project.audio.mastering = destination.mastering;
      draft.project.audio.bgm = destination.bgm;
    }
    validateDraft(draft);
    if (target === "project" || target === "delivery") {
      draft.project.updatedAt = nowIso();
      writeJson(join(model.root, PROJECT_FILES.project), draft.project);
    } else if (target === "script") writeJson(join(model.root, PROJECT_FILES.script), draft.script);
    else if (target === "voice") writeJson(join(model.root, PROJECT_FILES.voice), draft.voice);
    else if (target === "storyboard") writeJson(join(model.root, PROJECT_FILES.storyboard), draft.storyboard);
    else writeJson(join(model.root, PROJECT_FILES.design), draft.design);
    return;
  }
  if (target === "scene") {
    const path = join(model.root, "scenes", id, "shot-plan.json");
    const plan = readJson(path, {});
    for (const [name, value] of Object.entries(changed)) setPath(plan, name, value);
    plan.updatedAt = nowIso();
    writeJson(path, plan);
    return;
  }
  if (target === "caption") {
    const options = { id, style: {} };
    for (const [name, value] of Object.entries(changed)) {
      if (name.startsWith("style.")) options.style[name.slice("style.".length)] = value;
      else options[name] = value;
    }
    setCaptionOverride(model.root, options);
    return;
  }
  throw new Error(`未实现修改环节：${target}`);
}

function compileAfterEdit(prepared) {
  const target = prepared.section.target;
  if (target === "caption") return;
  if (prepared.impact.stages.length === 0) {
    if (target === "delivery") compileProject(prepared.model.root);
    return;
  }
  const suppressAutomaticInvalidationStages = [];
  if (target === "script") suppressAutomaticInvalidationStages.push("script");
  if (target === "project" || target === "storyboard") suppressAutomaticInvalidationStages.push("storyboard");
  if (target === "design") suppressAutomaticInvalidationStages.push("design");
  compileProject(prepared.model.root, {
    requestStoryboardApproval: prepared.impact.stages.includes("storyboard"),
    suppressAutomaticInvalidationStages,
  });
}

export function applyProjectEdit(projectRoot, request, options = {}) {
  const prepared = prepareEdit(projectRoot, request);
  if (!options.expectedFingerprint) throw new Error("应用修改前必须先执行影响预览");
  if (options.expectedFingerprint !== prepared.fingerprint) {
    throw new Error("修改预览已过期：项目或参数已变化，请重新预览后再应用");
  }
  if (prepared.changedFields.length === 0) {
    return { ...previewProjectEdit(projectRoot, request), appliedAt: null };
  }
  writeModelEdit(prepared);
  invalidateStages(prepared.model.root, prepared.impact.stages, {
    allScenes: prepared.impact.sceneScope === "all",
    sceneIds: prepared.impact.sceneIds,
  });
  compileAfterEdit(prepared);
  const afterModel = loadProjectModel(prepared.model.root);
  const afterHash = hashValue(sourceSnapshot(prepared.model.root, prepared.section.target, prepared.id, afterModel));
  const appliedAt = nowIso();
  appendJsonLine(join(prepared.model.root, ".harness", "edit-history.jsonl"), {
    at: appliedAt,
    target: prepared.section.target,
    id: prepared.id,
    changedFields: prepared.changedFields,
    beforeHash: prepared.sourceHash,
    afterHash,
    impact: prepared.impact,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    target: prepared.section.target,
    id: prepared.id,
    changed: true,
    changedFields: prepared.changedFields,
    impact: prepared.impact,
    appliedAt,
    state: loadState(prepared.model.root),
  };
}
