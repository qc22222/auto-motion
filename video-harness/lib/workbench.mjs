import { join } from "node:path";
import { PROJECT_FILES } from "./constants.mjs";
import { getEditCatalog } from "./editor.mjs";
import { writeText } from "./fs-utils.mjs";

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildEditWorkbenchHtml(catalog) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${catalog.project.title} · 分环节修改</title>
  <style>
    :root { color-scheme: light; --bg: #f5f2ea; --panel: #fffdf7; --ink: #24221d; --muted: #6d685d; --line: #d8d1c3; --accent: #d95d39; --accent-soft: #f9dfd5; --ok: #18794e; --warn: #9a6700; --shadow: 0 18px 48px rgba(55, 45, 28, .10); }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at 15% 0%, #fff9e9 0, transparent 32%), var(--bg); color: var(--ink); font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; }
    button, input, textarea, select { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 290px minmax(0, 1fr); }
    aside { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 26px 18px; border-right: 1px solid var(--line); background: rgba(255, 253, 247, .86); backdrop-filter: blur(18px); }
    .brand { padding: 0 10px 22px; }
    .brand small { color: var(--accent); font-weight: 800; letter-spacing: .08em; }
    .brand h1 { margin: 8px 0 6px; font-size: 23px; line-height: 1.25; }
    .brand p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    nav { display: grid; gap: 7px; }
    .nav-button { width: 100%; padding: 12px 13px; border: 1px solid transparent; border-radius: 12px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
    .nav-button:hover { background: #fff; border-color: var(--line); }
    .nav-button.active { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 28%, transparent); color: #742d1a; font-weight: 800; }
    .aside-link { display: block; margin: 18px 8px 0; color: var(--muted); font-size: 13px; }
    main { width: min(1040px, calc(100% - 44px)); margin: 0 auto; padding: 34px 0 70px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 24px; }
    .eyebrow { color: var(--accent); font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    h2 { margin: 7px 0 8px; font-size: clamp(30px, 4vw, 48px); line-height: 1.15; }
    .description { max-width: 720px; margin: 0; color: var(--muted); line-height: 1.7; }
    .status { min-width: 150px; padding: 10px 13px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--muted); font-size: 13px; }
    .control-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: center; margin-bottom: 20px; padding: 18px 20px; border: 1px solid var(--line); border-radius: 18px; background: #24221d; color: white; box-shadow: var(--shadow); }
    .control-panel .eyebrow { color: #f4b39e; }
    .control-summary { margin: 5px 0 0; color: #ded9cf; font-size: 13px; line-height: 1.55; }
    .control-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 9px; }
    .control-buttons .button { border-color: #5e594f; background: #34312b; color: white; }
    .control-buttons .button.primary { border-color: var(--accent); background: var(--accent); }
    .stage-strip { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
    .stage-pill { padding: 5px 8px; border: 1px solid #514d45; border-radius: 999px; color: #c9c3b8; font-size: 11px; }
    .stage-pill.done { border-color: #368267; color: #a8e6ca; }
    .stage-pill.gate { border-color: #c6952f; color: #ffe1a2; }
    .stage-pill.failed { border-color: #b85b4c; color: #ffc0b5; }
    .panel { padding: 24px; border: 1px solid var(--line); border-radius: 20px; background: var(--panel); box-shadow: var(--shadow); }
    .context-panel { margin-top: 20px; }
    .context-panel h3 { margin: 0 0 7px; font-size: 20px; }
    .context-panel p { margin: 0 0 14px; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .context-panel textarea { width: 100%; min-height: 88px; margin-bottom: 12px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; resize: vertical; }
    .readiness-list { display: grid; gap: 8px; margin: 14px 0; padding: 0; list-style: none; }
    .readiness-list li { padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: white; font-size: 12px; line-height: 1.5; }
    .readiness-list li.ok { border-color: #b6dfca; color: var(--ok); }
    .readiness-list li.bad { border-color: #efc2b7; color: #a33a25; }
    .entity-row { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
    .entity-row label { color: var(--muted); font-size: 13px; font-weight: 700; }
    .entity-row select { min-width: 280px; max-width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: white; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .field { min-width: 0; }
    .field.wide { grid-column: 1 / -1; }
    .field-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
    .field label { font-size: 14px; font-weight: 800; }
    .impact-mini { color: var(--muted); font-size: 11px; text-align: right; }
    .field input:not([type="checkbox"]), .field textarea, .field select { width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; outline: none; background: #fff; color: var(--ink); transition: border-color .15s, box-shadow .15s; }
    .field textarea { min-height: 104px; resize: vertical; line-height: 1.55; }
    .field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
    .field-help { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .toggle { min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: white; }
    .toggle input { width: 19px; height: 19px; accent-color: var(--accent); }
    .actions { position: sticky; bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 24px; padding: 14px; border: 1px solid var(--line); border-radius: 16px; background: rgba(255, 253, 247, .94); box-shadow: var(--shadow); backdrop-filter: blur(14px); }
    .action-copy { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .buttons { display: flex; gap: 10px; flex-shrink: 0; }
    .button { padding: 11px 17px; border: 1px solid var(--line); border-radius: 10px; background: white; color: var(--ink); font-weight: 800; cursor: pointer; }
    .button.primary { border-color: var(--accent); background: var(--accent); color: white; }
    .button:disabled { opacity: .38; cursor: not-allowed; }
    .impact-panel { display: none; margin-top: 20px; padding: 18px; border-radius: 15px; background: #fff8e7; border: 1px solid #ead7a8; }
    .impact-panel.show { display: block; }
    .impact-panel h3 { margin: 0 0 10px; font-size: 17px; }
    .chips { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0; }
    .chip { padding: 5px 9px; border-radius: 999px; background: white; border: 1px solid #ddc888; color: #6f5200; font-size: 12px; font-weight: 700; }
    .impact-panel ul { margin: 8px 0 0; padding-left: 20px; line-height: 1.65; }
    .notice { margin-bottom: 18px; padding: 12px 14px; border-radius: 12px; background: #edf8f2; border: 1px solid #b6dfca; color: var(--ok); font-size: 13px; line-height: 1.5; }
    .notice.error { background: #fff0ed; border-color: #efc2b7; color: #a33a25; }
    @media (max-width: 800px) { .shell { grid-template-columns: 1fr; } aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } nav { grid-template-columns: repeat(2, 1fr); } main { width: min(100% - 28px, 1040px); padding-top: 24px; } .fields { grid-template-columns: 1fr; } .topbar { display: block; } .status { margin-top: 14px; } .control-panel { grid-template-columns: 1fr; } .control-buttons { justify-content: stretch; } .control-buttons .button { flex: 1; } .stage-strip { grid-column: 1; } .actions { align-items: stretch; flex-direction: column; } .buttons { width: 100%; } .button { flex: 1; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand"><small>VIDEO HARNESS</small><h1>分环节修改工作台</h1><p>先看影响范围，再确认应用；不会直接改未知字段。</p></div>
      <nav id="nav"></nav>
      <a class="aside-link" href="./reviews/index.html">← 返回审阅页</a>
    </aside>
    <main>
      <div id="notice" hidden></div>
      <div class="topbar">
        <div><div class="eyebrow" id="target-label"></div><h2 id="title"></h2><p class="description" id="description"></p></div>
        <div class="status" id="status">尚未修改</div>
      </div>
      <section class="control-panel" aria-label="流水线控制">
        <div><div class="eyebrow">流水线控制</div><p class="control-summary" id="pipeline-summary">正在读取当前质量门……</p></div>
        <div class="control-buttons">
          <button class="button" id="approve-stage" type="button" hidden>批准当前质量门</button>
          <button class="button primary" id="advance-pipeline" type="button">推进到下一质量门</button>
        </div>
        <div class="stage-strip" id="stage-strip" aria-label="各阶段状态"></div>
      </section>
      <section class="panel">
        <div class="entity-row"><label for="entity">修改对象</label><select id="entity"></select></div>
        <form id="form" class="fields"></form>
        <div id="impact" class="impact-panel"></div>
      </section>
      <section class="panel context-panel" id="scene-tools" hidden>
        <h3>当前镜头的执行与返工</h3>
        <p>上方用于修改镜头参数；下方用于执行生成，或把一条具体意见加入局部返工队列。两者影响不同。</p>
        <textarea id="review-comment" maxlength="5000" placeholder="例如：标题再放大 15%，保持其他构图和节奏不变。"></textarea>
        <div class="buttons">
          <button class="button" id="generate-scene" type="button">生成或返工当前镜头</button>
          <button class="button primary" id="submit-comment" type="button">提交局部意见</button>
        </div>
      </section>
      <section class="panel context-panel" id="audio-tools" hidden>
        <h3>音频与背景音乐生产预检</h3>
        <p id="audio-readiness-summary">音色和 BGM 的参数、依赖与凭据会按当前提供方分别检查。</p>
        <ul class="readiness-list" id="audio-readiness-list"></ul>
        <div class="buttons">
          <button class="button" id="refresh-audio" type="button">重新检查生产条件</button>
          <button class="button primary" id="regenerate-audio" type="button">强制重生成本段配音</button>
        </div>
        <p id="voice-preview-copy" hidden>当前段配音已生成，可在这里直接试听；重新生成后播放器会自动刷新。</p>
        <audio id="voice-preview" controls preload="metadata" hidden></audio>
      </section>
      <div class="actions">
        <div class="action-copy">应用前会再次校验项目是否变化；过期预览必须重做。</div>
        <div class="buttons"><button class="button" id="preview" type="button">预览影响</button><button class="button primary" id="apply" type="button" disabled>确认应用</button></div>
      </div>
    </main>
  </div>
  <script>
    (function () {
      let catalog = ${safeJson(catalog)};
      const params = new URLSearchParams(location.search);
      let target = params.get("target") || catalog.sections[0].target;
      let selectedId = params.get("id") || null;
      let previewResult = null;
      let initialValues = {};
      const stageLabels = { script: "文案", audio: "音频", storyboard: "分镜", design: "设计", scenes: "镜头", captions: "字幕", review: "审阅", render: "渲染", delivery: "交付" };
      const nav = document.getElementById("nav");
      const form = document.getElementById("form");
      const entity = document.getElementById("entity");
      const impact = document.getElementById("impact");
      const applyButton = document.getElementById("apply");
      const previewButton = document.getElementById("preview");
      const approveStageButton = document.getElementById("approve-stage");
      const advancePipelineButton = document.getElementById("advance-pipeline");
      const generateSceneButton = document.getElementById("generate-scene");
      const submitCommentButton = document.getElementById("submit-comment");
      const sceneTools = document.getElementById("scene-tools");
      const audioTools = document.getElementById("audio-tools");
      const refreshAudioButton = document.getElementById("refresh-audio");
      const regenerateAudioButton = document.getElementById("regenerate-audio");
      const voicePreview = document.getElementById("voice-preview");
      const voicePreviewCopy = document.getElementById("voice-preview-copy");
      const qualityGates = ["script", "storyboard", "review"];
      const pipelineStages = ["script", "audio", "storyboard", "design", "scenes", "captions", "review", "render", "delivery"];

      function section() { return catalog.sections.find(function (item) { return item.target === target; }) || catalog.sections[0]; }
      function currentItem() { const current = section(); return current.items.find(function (item) { return item.id === selectedId; }) || current.items[0]; }
      function setNotice(message, error) { const node = document.getElementById("notice"); node.hidden = !message; node.className = "notice" + (error ? " error" : ""); node.textContent = message || ""; }
      function resetPreview() { previewResult = null; applyButton.disabled = true; impact.classList.remove("show"); document.getElementById("status").textContent = "有未预览的修改"; }
      function serialize(value) { return JSON.stringify(value === undefined ? null : value); }
      function normalizeInitial(field, value) {
        if (field.type === "boolean") return Boolean(value);
        if (field.type === "string-list") return Array.isArray(value) ? value : [];
        if (["text", "textarea", "color", "select"].includes(field.type)) return value == null ? "" : String(value);
        return value;
      }
      function readControl(control, field) {
        if (field.type === "boolean") return control.checked;
        if (field.type === "number") return control.value === "" ? undefined : Number(control.value);
        if (field.type === "string-list") return control.value.split(/\\r?\\n/).map(function (item) { return item.trim(); }).filter(Boolean);
        return control.value;
      }
      function collectChanges() {
        const changes = {};
        section().fields.forEach(function (field) {
          const control = form.elements.namedItem(field.name);
          if (!control || control.closest(".field")?.hidden) return;
          const value = readControl(control, field);
          if (serialize(value) !== serialize(initialValues[field.name])) changes[field.name] = value;
        });
        return changes;
      }
      function assertNoUnappliedChanges() {
        if (Object.keys(collectChanges()).length > 0) throw new Error("当前参数还有未应用的修改；请先预览并确认，或还原后再执行流水线动作。");
      }
      function createControl(field, value) {
        let control;
        if (field.type === "textarea" || field.type === "string-list") {
          control = document.createElement("textarea");
          control.value = field.type === "string-list" ? (value || []).join("\\n") : (value == null ? "" : value);
        } else if (field.type === "select") {
          control = document.createElement("select");
          (field.options || []).forEach(function (option) { const node = document.createElement("option"); node.value = option.value; node.textContent = option.label; control.appendChild(node); });
          control.value = value == null ? "" : value;
        } else if (field.type === "boolean") {
          const wrapper = document.createElement("div"); wrapper.className = "toggle";
          control = document.createElement("input"); control.type = "checkbox"; control.checked = Boolean(value);
          const copy = document.createElement("span"); copy.textContent = control.checked ? "已启用" : "未启用";
          control.addEventListener("change", function () { copy.textContent = control.checked ? "已启用" : "未启用"; });
          wrapper.append(control, copy); control._wrapper = wrapper;
        } else {
          control = document.createElement("input"); control.type = field.type === "number" ? "number" : "text"; control.value = value == null ? "" : value;
          ["min", "max", "step"].forEach(function (key) { if (field[key] != null) control.setAttribute(key, field[key]); });
        }
        control.name = field.name;
        control.addEventListener("input", resetPreview);
        control.addEventListener("change", resetPreview);
        return control;
      }
      function renderNav() {
        nav.replaceChildren();
        catalog.sections.forEach(function (item) {
          const button = document.createElement("button"); button.type = "button"; button.className = "nav-button" + (item.target === target ? " active" : ""); button.textContent = item.title;
          button.addEventListener("click", function () { target = item.target; selectedId = item.items[0] ? item.items[0].id : null; render(); });
          nav.appendChild(button);
        });
      }
      function updateVoiceProviderFields() {
        if (target !== "voice") return;
        const provider = form.elements.namedItem("provider")?.value || "";
        section().fields.forEach(function (field) {
          const control = form.elements.namedItem(field.name);
          if (!control) return;
          const wrapper = control.closest(".field");
          if (wrapper) {
            wrapper.hidden = Array.isArray(field.appliesToProviders)
              && !field.appliesToProviders.includes(provider);
          }
          const constraints = field.providerConstraints?.[provider];
          if (constraints && field.type === "number") {
            ["min", "max", "step"].forEach(function (key) {
              const value = constraints[key] ?? field[key];
              if (value == null) control.removeAttribute(key);
              else control.setAttribute(key, value);
            });
          }
        });
      }
      async function refreshVoicePreview() {
        const canPreview = target === "script" && Boolean(selectedId);
        if (!canPreview) {
          voicePreview.pause();
          voicePreview.removeAttribute("src");
          voicePreview.hidden = true;
          voicePreviewCopy.hidden = true;
          return;
        }
        const path = "/assets/voice/" + encodeURIComponent(selectedId) + ".wav";
        const response = await fetch(path, { method: "HEAD", cache: "no-store" });
        voicePreview.hidden = !response.ok;
        voicePreviewCopy.hidden = !response.ok;
        if (response.ok) {
          voicePreview.src = path + "?v=" + Date.now();
          voicePreview.load();
        }
      }
      function render() {
        const current = section();
        if (current.target !== target) target = current.target;
        if (!current.items.some(function (item) { return item.id === selectedId; })) selectedId = current.items[0] ? current.items[0].id : null;
        renderNav();
        document.getElementById("target-label").textContent = catalog.project.title + " · " + target;
        document.getElementById("title").textContent = current.title;
        document.getElementById("description").textContent = current.description;
        entity.replaceChildren();
        current.items.forEach(function (item) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; entity.appendChild(option); });
        entity.value = selectedId || ""; entity.disabled = current.items.length <= 1;
        form.replaceChildren();
        const item = currentItem(); initialValues = {};
        current.fields.forEach(function (field) { initialValues[field.name] = normalizeInitial(field, item ? item.values[field.name] : undefined); });
        current.fields.forEach(function (field) {
          const wrapper = document.createElement("div"); wrapper.className = "field" + (["textarea", "string-list"].includes(field.type) ? " wide" : "");
          const head = document.createElement("div"); head.className = "field-head";
          const label = document.createElement("label"); label.textContent = field.label;
          const mini = document.createElement("span"); mini.className = "impact-mini"; mini.textContent = field.impact.stages.length ? "影响：" + field.impact.stages.map(function (stage) { return stageLabels[stage] || stage; }).join(" / ") : "不触发重算";
          head.append(label, mini);
          const control = createControl(field, initialValues[field.name]); label.htmlFor = "field-" + field.name.replaceAll(".", "-"); control.id = label.htmlFor;
          wrapper.append(head, control._wrapper || control);
          if (field.help) { const help = document.createElement("p"); help.className = "field-help"; help.textContent = field.help; wrapper.appendChild(help); }
          form.appendChild(wrapper);
        });
        const providerControl = form.elements.namedItem("provider");
        if (providerControl) providerControl.addEventListener("change", updateVoiceProviderFields);
        updateVoiceProviderFields();
        history.replaceState(null, "", location.pathname + "?target=" + encodeURIComponent(target) + (selectedId ? "&id=" + encodeURIComponent(selectedId) : ""));
        sceneTools.hidden = target !== "scene" || !selectedId;
        audioTools.hidden = !["script", "voice", "delivery"].includes(target);
        regenerateAudioButton.hidden = target === "delivery";
        regenerateAudioButton.textContent = target === "script" ? "强制重生成本段配音" : "强制重生成全部配音";
        previewResult = null; applyButton.disabled = true; impact.classList.remove("show"); document.getElementById("status").textContent = "尚未修改"; setNotice("");
        if (!audioTools.hidden) refreshAudioReadiness().catch(function (error) { setNotice(error.message, true); });
        refreshVoicePreview().catch(function () { voicePreview.hidden = true; voicePreviewCopy.hidden = true; });
      }
      async function api(path, payload) {
        if (location.protocol === "file:") throw new Error("当前以文件方式打开。请运行 video-harness serve <项目目录> 后从本地地址进入，才能安全应用修改。");
        const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-video-harness": "1" }, body: JSON.stringify(payload) });
        const result = await response.json().catch(function () { return { error: "服务返回了无法解析的响应" }; });
        if (!response.ok) throw new Error(result.error || "请求失败");
        return result;
      }
      async function getJson(path) {
        const response = await fetch(path, { cache: "no-store" });
        const result = await response.json().catch(function () { return { error: "服务返回了无法解析的响应" }; });
        if (!response.ok) throw new Error(result.error || "请求失败");
        return result;
      }
      async function refreshCatalog() {
        catalog = await getJson("/api/edit/catalog");
      }
      async function refreshAudioReadiness() {
        refreshAudioButton.disabled = true;
        try {
          const report = await getJson("/api/audio/readiness");
          document.getElementById("audio-readiness-summary").textContent = report.ready
            ? "当前 " + report.provider + " 路由已通过本地生产预检；首次远程调用仍需用小样确认授权与音色。"
            : "当前 " + report.provider + " 路由尚不可生产，请按下列项目逐项补齐。";
          const list = document.getElementById("audio-readiness-list"); list.replaceChildren();
          report.checks.forEach(function (check) {
            const item = document.createElement("li"); item.className = check.ok ? "ok" : "bad";
            item.textContent = (check.ok ? "✓ " : "✗ ") + check.label + "：" + check.detail + (check.ok || !check.fix ? "" : "；建议：" + check.fix);
            list.appendChild(item);
          });
          return report;
        } finally { refreshAudioButton.disabled = false; }
      }
      async function refreshPipeline() {
        const status = await getJson("/api/status");
        const active = status.activeJob;
        const gate = qualityGates.find(function (stage) { return status.state.stages[stage]?.status === "needs_approval"; });
        const pending = pipelineStages.find(function (stage) { return !["complete", "approved"].includes(status.state.stages[stage]?.status); });
        document.getElementById("pipeline-summary").textContent = active
          ? "正在执行 " + active.type + "，任务 " + active.id.slice(0, 8) + "。执行期间暂停其他写入。"
          : gate
            ? "当前停在“" + (stageLabels[gate] || gate) + "”质量门。请先审阅；批准不会修改参数。"
            : pending
              ? "下一待处理阶段：“" + (stageLabels[pending] || pending) + "”。推进只会重算尚未完成或已失效的环节。"
              : "全部阶段均已完成。参数修改后会按影响矩阵精准标记待重算范围。";
        approveStageButton.hidden = !gate;
        approveStageButton.dataset.stage = gate || "";
        approveStageButton.disabled = Boolean(active);
        advancePipelineButton.disabled = Boolean(active);
        generateSceneButton.disabled = Boolean(active);
        submitCommentButton.disabled = Boolean(active);
        regenerateAudioButton.disabled = Boolean(active);
        const strip = document.getElementById("stage-strip"); strip.replaceChildren();
        pipelineStages.forEach(function (stage) {
          const state = status.state.stages[stage]?.status || "unknown";
          const pill = document.createElement("span");
          pill.className = "stage-pill" + (["complete", "approved"].includes(state) ? " done" : state === "needs_approval" ? " gate" : state === "failed" ? " failed" : "");
          pill.textContent = (stageLabels[stage] || stage) + " · " + state;
          strip.appendChild(pill);
        });
        return status;
      }
      async function waitForJob(job) {
        let current = job;
        while (["queued", "running"].includes(current.status)) {
          document.getElementById("pipeline-summary").textContent = "正在执行 " + current.type + "，请保持页面打开；可安全切换到其他标签查看。";
          await new Promise(function (resolve) { setTimeout(resolve, 500); });
          current = await getJson("/api/jobs/" + encodeURIComponent(current.id));
        }
        if (current.status === "failed") throw new Error(current.error || "任务执行失败");
        return current;
      }
      async function runJob(path, payload, successMessage) {
        assertNoUnappliedChanges();
        const accepted = await api(path, payload || {});
        await refreshPipeline();
        const job = await waitForJob(accepted.job);
        await refreshCatalog();
        render();
        await refreshPipeline();
        setNotice(successMessage + (job.result?.message ? " " + job.result.message : ""), false);
        return job;
      }
      entity.addEventListener("change", function () { selectedId = entity.value; render(); });
      previewButton.addEventListener("click", async function () {
        try {
          previewButton.disabled = true; setNotice("");
          const changes = collectChanges();
          if (Object.keys(changes).length === 0) throw new Error("当前参数没有变化");
          previewResult = await api("/api/edit/preview", { target: target, id: selectedId, changes: changes });
          impact.replaceChildren();
          const heading = document.createElement("h3"); heading.textContent = "本次修改的实际影响"; impact.appendChild(heading);
          const chips = document.createElement("div"); chips.className = "chips";
          previewResult.impact.stages.forEach(function (stage) { const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = stageLabels[stage] || stage; chips.appendChild(chip); }); impact.appendChild(chips);
          const list = document.createElement("ul"); previewResult.impact.summary.forEach(function (text) { const item = document.createElement("li"); item.textContent = text; list.appendChild(item); }); impact.appendChild(list);
          impact.classList.add("show"); applyButton.disabled = !previewResult.changed; document.getElementById("status").textContent = "影响已预览，等待确认";
        } catch (error) { setNotice(error.message, true); }
        finally { previewButton.disabled = false; }
      });
      applyButton.addEventListener("click", async function () {
        try {
          if (!previewResult) throw new Error("请先预览影响");
          applyButton.disabled = true;
          const changes = collectChanges();
          const result = await api("/api/edit/apply", { target: target, id: selectedId, changes: changes, expectedFingerprint: previewResult.fingerprint });
          await refreshCatalog();
          render(); setNotice("修改已应用。已按影响矩阵撤销相关审批并标记待重算阶段。", false); document.getElementById("status").textContent = "修改已应用";
          await refreshPipeline();
        } catch (error) { setNotice(error.message, true); applyButton.disabled = false; }
      });
      advancePipelineButton.addEventListener("click", async function () {
        try { await runJob("/api/pipeline/advance", {}, "流水线推进完成。"); }
        catch (error) { setNotice(error.message, true); await refreshPipeline().catch(function () {}); }
      });
      regenerateAudioButton.addEventListener("click", async function () {
        try {
          const payload = target === "script" ? { segmentId: selectedId } : {};
          const message = target === "script" ? "当前旁白段已强制重生成，可立即试听。" : "全部旁白已强制重生成。";
          await runJob("/api/audio/regenerate", payload, message);
        } catch (error) { setNotice(error.message, true); await refreshPipeline().catch(function () {}); }
      });
      approveStageButton.addEventListener("click", async function () {
        try {
          assertNoUnappliedChanges();
          const stage = approveStageButton.dataset.stage;
          if (!stage) throw new Error("当前没有等待批准的质量门");
          await api("/api/stages/approve", { stage: stage, note: "从本地修改工作台批准" });
          await refreshPipeline();
          setNotice("已批准“" + (stageLabels[stage] || stage) + "”质量门；审批本身没有改动任何参数。", false);
        } catch (error) { setNotice(error.message, true); }
      });
      generateSceneButton.addEventListener("click", async function () {
        try { await runJob("/api/scenes/generate", { sceneId: selectedId }, "当前镜头生成任务已完成。"); }
        catch (error) { setNotice(error.message, true); await refreshPipeline().catch(function () {}); }
      });
      submitCommentButton.addEventListener("click", async function () {
        try {
          assertNoUnappliedChanges();
          const input = document.getElementById("review-comment");
          const text = input.value.trim();
          if (!text) throw new Error("请先填写具体的局部修改意见");
          await api("/api/review/comments", { sceneId: selectedId, pass: "final", text: text });
          input.value = "";
          await refreshPipeline();
          setNotice("局部意见已记录；只将当前镜头及其下游标记为待返工。", false);
        } catch (error) { setNotice(error.message, true); }
      });
      refreshAudioButton.addEventListener("click", function () {
        refreshAudioReadiness().catch(function (error) { setNotice(error.message, true); });
      });
      render();
      refreshPipeline().catch(function (error) { setNotice(error.message, true); });
    })();
  </script>
</body>
</html>`;
}

export function writeEditWorkbench(projectRoot) {
  const catalog = getEditCatalog(projectRoot);
  const path = join(projectRoot, PROJECT_FILES.editHtml);
  writeText(path, buildEditWorkbenchHtml(catalog));
  return path;
}
