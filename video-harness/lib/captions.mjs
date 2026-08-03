import { join } from "node:path";
import { compileProject } from "./compile.mjs";
import { PROJECT_FILES, SCHEMA_VERSION } from "./constants.mjs";
import { hashValue, readJson, writeJson, writeText } from "./fs-utils.mjs";
import { loadProjectModel } from "./model.mjs";
import { invalidateFrom, setStage } from "./state.mjs";
import { formatTimestamp, round3 } from "./timing.mjs";

const SENTENCE_END_RE = /[。！？!?]$/u;
const CLAUSE_END_RE = /[，、；：,;:]$/u;

function tokenLength(text) {
  return [...String(text || "").replace(/\s+/g, "")].length;
}

function needsSpace(previous, current) {
  return /[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(current);
}

export function joinCaptionTokens(tokens) {
  let output = "";
  for (const token of tokens) {
    const text = String(token || "");
    if (output && needsSpace(output, text)) output += " ";
    output += text;
  }
  return output;
}

function absoluteWords(model, audioMeta) {
  const sceneStarts = new Map();
  let cursor = 0;
  for (const scene of model.storyboard.scenes) {
    sceneStarts.set(scene.id, cursor);
    cursor += Number(scene.duration) || 0;
  }
  const words = [];
  for (const voice of audioMeta.voices || []) {
    const sceneStart = sceneStarts.get(voice.sceneId || voice.scene_id);
    if (!Number.isFinite(sceneStart)) continue;
    const voiceStart = Number(voice.scene_offset_s) || 0;
    for (const word of voice.words || []) {
      const text = String(word.text || "").trim();
      if (!text || !Number.isFinite(Number(word.start)) || !Number.isFinite(Number(word.end))) continue;
      words.push({
        text,
        sceneId: voice.sceneId || voice.scene_id,
        frame: voice.frame,
        start: round3(sceneStart + voiceStart + Number(word.start)),
        end: round3(sceneStart + voiceStart + Number(word.end)),
      });
    }
  }
  return words.sort((left, right) => left.start - right.start);
}

export function groupCaptionWords(words, options = {}) {
  const maxChars = Math.max(6, Number(options.maxChars) || 14);
  const maxGap = Math.max(0.1, Number(options.maxGap) || 0.24);
  const rawGroups = [];
  let current = null;
  for (const word of words) {
    const previous = current?.words.at(-1);
    const nextLength = (current?.charCount || 0) + tokenLength(word.text);
    const shouldSplit =
      !current ||
      current.sceneId !== word.sceneId ||
      (previous && word.start - previous.end > maxGap) ||
      nextLength > maxChars;
    if (shouldSplit) {
      if (current) rawGroups.push(current);
      current = { sceneId: word.sceneId, frame: word.frame, charCount: 0, words: [] };
    }
    current.words.push(word);
    current.charCount += tokenLength(word.text);
    if (
      SENTENCE_END_RE.test(word.text) ||
      (CLAUSE_END_RE.test(word.text) && current.charCount >= Math.ceil(maxChars * 0.55))
    ) {
      rawGroups.push(current);
      current = null;
    }
  }
  if (current) rawGroups.push(current);

  return rawGroups.map((group, index) => {
    const next = rawGroups[index + 1];
    const first = group.words[0];
    const last = group.words.at(-1);
    let end = round3(last.end + 0.14);
    if (next && next.words[0].start < end) end = round3(next.words[0].start);
    return {
      id: `caption-${String(index + 1).padStart(3, "0")}`,
      sceneId: group.sceneId,
      frame: group.frame,
      start: round3(first.start),
      end,
      text: joinCaptionTokens(group.words.map((word) => word.text)),
      words: group.words.map((word, wordIndex) => ({
        id: `caption-${index + 1}-word-${wordIndex + 1}`,
        text: word.text,
        start: word.start,
        end: word.end,
      })),
    };
  });
}

function normalizeOverrides(value) {
  if (Array.isArray(value)) return { schemaVersion: SCHEMA_VERSION, items: value };
  return {
    schemaVersion: SCHEMA_VERSION,
    items: Array.isArray(value?.items) ? value.items : [],
  };
}

export function applyCaptionOverrides(groups, overrideFile) {
  const overrides = normalizeOverrides(overrideFile);
  const byId = new Map(
    overrides.items
      .filter((item) => item && (item.captionId || item.id))
      .map((item) => [item.captionId || item.id, item]),
  );
  const output = [];
  for (const group of groups) {
    const override = byId.get(group.id);
    if (!override) {
      output.push(group);
      continue;
    }
    if (override.hidden === true) continue;
    const start = override.start == null ? group.start : round3(Number(override.start));
    const end = override.end == null ? group.end : round3(Number(override.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`字幕覆盖 ${group.id} 的 start/end 无效`);
    }
    const text = override.text == null ? group.text : String(override.text).trim();
    if (!text) throw new Error(`字幕覆盖 ${group.id} 的 text 不能为空`);
    const next = { ...group, start, end, text, style: override.style || undefined };
    if (override.text != null) {
      next.words = [{ id: `${group.id}-override`, text, start, end }];
    } else {
      next.words = group.words.map((word) => ({
        ...word,
        start: Math.max(start, word.start),
        end: Math.min(end, word.end),
      }));
    }
    output.push(next);
  }
  return output;
}

export function setCaptionOverride(projectRoot, options) {
  const id = String(options.id || "").trim();
  if (!id) throw new Error("字幕覆盖需要 id");
  const path = join(projectRoot, PROJECT_FILES.captionOverrides);
  const overrides = normalizeOverrides(readJson(path, { schemaVersion: SCHEMA_VERSION, items: [] }));
  const current = overrides.items.find((item) => (item.captionId || item.id) === id) || { captionId: id };
  if (options.text !== undefined) current.text = options.text;
  if (options.start !== undefined) current.start = Number(options.start);
  if (options.end !== undefined) current.end = Number(options.end);
  if (options.hidden !== undefined) current.hidden = Boolean(options.hidden);
  if (options.style && Object.keys(options.style).length > 0) current.style = { ...(current.style || {}), ...options.style };
  const index = overrides.items.findIndex((item) => (item.captionId || item.id) === id);
  if (index >= 0) overrides.items[index] = current;
  else overrides.items.push(current);
  writeJson(path, overrides);
  invalidateFrom(projectRoot, "captions");
  return current;
}

function buildSrt(groups) {
  return groups
    .map(
      (group, index) =>
        `${index + 1}\n${formatTimestamp(group.start)} --> ${formatTimestamp(group.end)}\n${group.text}\n`,
    )
    .join("\n");
}

function buildVtt(groups) {
  const body = groups
    .map(
      (group) =>
        `${formatTimestamp(group.start, ".")} --> ${formatTimestamp(group.end, ".")}\n${group.text}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secs = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function colorToAss(value, fallback = "&H00000000") {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value || "").trim());
  if (hex) {
    const [red, green, blue] = [hex[1].slice(0, 2), hex[1].slice(2, 4), hex[1].slice(4, 6)];
    return `&H00${blue}${green}${red}`.toUpperCase();
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(String(value || "").trim());
  if (rgba) {
    const byte = (number) => Math.max(0, Math.min(255, Number(number))).toString(16).padStart(2, "0");
    const alpha = rgba[4] == null ? 0 : Math.round((1 - Math.max(0, Math.min(1, Number(rgba[4])))) * 255);
    return `&H${byte(alpha)}${byte(rgba[3])}${byte(rgba[2])}${byte(rgba[1])}`.toUpperCase();
  }
  return fallback;
}

function assTagColor(value, channel = 1) {
  const color = colorToAss(value, "&H00FFFFFF");
  const alpha = color.slice(2, 4);
  const bgr = color.slice(4);
  return `\\${channel}c&H${bgr}&\\${channel}a&H${alpha}&`;
}

function escapeAssText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, "\\N");
}

function buildAss(model, groups) {
  const width = model.project.render.width;
  const height = model.project.render.height;
  const fontName = model.design.typography?.body || "Microsoft YaHei";
  const fontSize = Math.max(20, Math.round(height * 0.038));
  const marginX = Math.max(20, Number(model.design.layout?.safeMarginX) || Math.round(width * 0.07));
  const marginV = Math.max(20, Number(model.design.layout?.safeMarginY) || Math.round(height * 0.06));
  const primary = colorToAss(model.design.palette?.canvas || "#FFFFFF", "&H00FFFFFF");
  const background = colorToAss(model.design.captions?.background || "rgba(0,0,0,0.72)", "&H40000000");
  const events = groups.map((group) => {
    const style = group.style || {};
    const tags = [];
    if (style.fontSize != null) tags.push(`\\fs${Math.max(8, Number(style.fontSize) || fontSize)}`);
    if (style.color != null) tags.push(assTagColor(style.color, 1));
    if (style.background != null) tags.push(assTagColor(style.background, 3));
    if (style.offsetX != null || style.offsetY != null) {
      const x = Math.round(width / 2 + (Number(style.offsetX) || 0));
      const y = Math.round(height - marginV + (Number(style.offsetY) || 0));
      tags.push(`\\pos(${x},${y})`);
    }
    const prefix = tags.length > 0 ? `{${tags.join("")}}` : "";
    return `Dialogue: 0,${assTimestamp(group.start)},${assTimestamp(group.end)},Default,,0,0,0,,${prefix}${escapeAssText(group.text)}`;
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,${fontName},${fontSize},${primary},${primary},${background},${background},-1,0,0,0,100,100,0,0,3,5,0,2,${marginX},${marginX},${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events.join("\n")}
`;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildCaptionsHtml(model, groups) {
  const { project, design, storyboard } = model;
  const width = project.render.width;
  const height = project.render.height;
  const bandHeight = Math.round(height * (design.layout?.captionBandRatio || 0.17));
  const bandBottom = Math.max(20, Number(design.layout?.safeMarginY) || Math.round(height * 0.06));
  const fontSize = Math.round(height * 0.035);
  const background = design.captions?.background || "rgba(0,0,0,0.72)";
  const ink = design.palette?.canvas || "#ffffff";
  const active = design.captions?.activeColor || design.palette?.accent || "#ffcc00";
  const body = design.typography?.body || "Microsoft YaHei";
  const safeGroups = JSON.stringify(groups).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${width}, height=${height}" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
    #root { position: relative; width: 100%; height: 100%; pointer-events: none; }
    #caption-band { position: absolute; left: 0; right: 0; bottom: ${bandBottom}px; height: ${bandHeight}px; display: flex; align-items: center; justify-content: center; }
    .caption-group { position: absolute; max-width: 86%; padding: ${Math.round(fontSize * 0.34)}px ${Math.round(fontSize * 0.7)}px; border-radius: ${Math.round(fontSize * 0.32)}px; background: ${htmlEscape(background)}; color: ${htmlEscape(ink)}; font-family: ${JSON.stringify(body)}, sans-serif; font-size: ${fontSize}px; font-weight: 700; line-height: 1.25; text-align: center; opacity: 0; visibility: hidden; }
    .caption-word { color: ${htmlEscape(ink)}; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="captions" data-start="0" data-duration="${storyboard.totalDuration}" data-width="${width}" data-height="${height}">
    <div id="caption-band"></div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    (function () {
      const groups = ${safeGroups};
      const band = document.getElementById("caption-band");
      const timeline = gsap.timeline({ paused: true });
      const latin = /[A-Za-z0-9]/;
      groups.forEach((group) => {
        const element = document.createElement("div");
        element.className = "caption-group";
        const style = group.style || {};
        ["fontSize", "background", "color", "maxWidth", "textAlign", "borderRadius", "padding"].forEach((key) => {
          if (style[key] != null) element.style[key] = typeof style[key] === "number" && key === "fontSize" ? style[key] + "px" : style[key];
        });
        if (style.offsetX != null || style.offsetY != null) {
          element.style.transform = "translate(" + (style.offsetX || 0) + "px," + (style.offsetY || 0) + "px)";
        }
        let previous = "";
        group.words.forEach((word, index) => {
          if (previous && latin.test(previous.slice(-1)) && latin.test(word.text.slice(0, 1))) {
            element.appendChild(document.createTextNode(" "));
          }
          const span = document.createElement("span");
          span.className = "caption-word";
          span.textContent = word.text;
          element.appendChild(span);
          timeline.set(span, { color: ${JSON.stringify(active)} }, word.start);
          timeline.set(span, { color: ${JSON.stringify(ink)} }, word.end);
          previous = word.text;
        });
        band.appendChild(element);
        timeline.set(element, { autoAlpha: 1 }, group.start);
        timeline.set(element, { autoAlpha: 0 }, group.end);
      });
      timeline.to({}, { duration: ${storyboard.totalDuration} }, 0);
      window.__timelines = window.__timelines || {};
      window.__timelines.captions = timeline;
    })();
  </script>
</body>
</html>
`;
}

export function generateCaptions(projectRoot) {
  compileProject(projectRoot);
  const model = loadProjectModel(projectRoot);
  const audioMeta = readJson(join(model.root, PROJECT_FILES.audioMeta));
  const overridePath = join(model.root, PROJECT_FILES.captionOverrides);
  const overrides = normalizeOverrides(readJson(overridePath, { schemaVersion: SCHEMA_VERSION, items: [] }));
  const inputHash = hashValue({
    voices: audioMeta.voices,
    storyboard: model.storyboard,
    presentation: {
      captions: model.design.captions,
      typography: { body: model.design.typography?.body },
      layout: {
        safeMarginX: model.design.layout?.safeMarginX,
        safeMarginY: model.design.layout?.safeMarginY,
        captionBandRatio: model.design.layout?.captionBandRatio,
      },
      palette: {
        canvas: model.design.palette?.canvas,
        accent: model.design.palette?.accent,
      },
      render: {
        width: model.project.render.width,
        height: model.project.render.height,
      },
    },
    overrides,
  });
  invalidateFrom(model.root, "captions");
  setStage(model.root, "captions", "running", { inputHash });
  try {
    const words = model.design.captions?.enabled === false ? [] : absoluteWords(model, audioMeta);
    const groups = applyCaptionOverrides(
      groupCaptionWords(words, {
        maxChars: model.design.captions?.maxChars,
      }),
      overrides,
    );
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      total_duration_s: model.storyboard.totalDuration,
      width: model.project.render.width,
      height: model.project.render.height,
      groups,
    };
    writeJson(join(model.root, PROJECT_FILES.captionGroups), payload);
    writeText(join(model.root, PROJECT_FILES.captionsSrt), buildSrt(groups));
    writeText(join(model.root, PROJECT_FILES.captionsVtt), buildVtt(groups));
    writeText(join(model.root, PROJECT_FILES.captionsAss), buildAss(model, groups));
    writeText(join(model.root, "compositions", "captions.html"), buildCaptionsHtml(model, groups));
    writeJson(overridePath, overrides);
    const outputHash = hashValue(payload);
    setStage(model.root, "captions", "complete", { inputHash, outputHash });
    return payload;
  } catch (error) {
    setStage(model.root, "captions", "failed", { inputHash, error: error.message });
    throw error;
  }
}
