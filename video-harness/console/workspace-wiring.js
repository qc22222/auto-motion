// ── OpenDesign 工作区接线(真实数据,2026-08-03)──────────────────────────
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (s) => Number(s || 0).toFixed(2);
  const stageStateText = (s) => ["complete", "approved"].includes(s) ? "已完成"
    : s === "needs_approval" ? "待审批" : s === "running" ? "进行中"
    : s === "failed" ? "失败" : s === "ready" ? "待处理" : "未开始";

  (async () => {
    try {
      const [project, status] = await Promise.all([
        ConsoleApi.getJson("/api/project"),
        ConsoleApi.getJson("/api/status"),
      ]);
      const stages = status.state.stages || {};
      const scenes = project.storyboard?.scenes || [];
      const segments = project.script?.segments || [];

      // 顶部状态徽章
      const badge = document.querySelector(".topbar-actions .status");
      if (badge) {
        const gate = ["script", "storyboard", "review"].find((s) => stages[s]?.status === "needs_approval");
        const running = Object.values(stages).some((s) => s?.status === "running");
        badge.textContent = running ? "任务进行中" : gate ? "停在" + ConsoleApi.stageLabel(gate) + "质量门" : "项目正常";
        badge.className = "status " + (gate ? "pending" : "success");
      }

      // ── 逐段文案(script panel)──────────────────────────────
      const scriptPanel = document.querySelector('.work-panel[data-work-panel="script"] .list-panel');
      if (scriptPanel) {
        scriptPanel.querySelectorAll(".content-row").forEach((el) => el.remove());
        const count = scriptPanel.querySelector(".list-title .tag");
        if (count) count.textContent = segments.length + " 段";
        const sceneById = Object.fromEntries(scenes.map((s) => [s.id, s]));
        segments.forEach((seg, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "content-row" + (i === 0 ? " active" : "");
          row.dataset.scriptId = seg.id;
          const scene = sceneById[seg.sceneId];
          row.innerHTML = '<span class="row-id">' + String(i + 1).padStart(2, "0") + "</span>"
            + "<div><strong>" + (seg.text || "") + "</strong><small>"
            + (seg.label || "") + (scene ? " · " + scene.id : "") + "</small></div>"
            + (scene ? '<span class="mono muted">' + fmt(scene.duration) + "s</span>" : "");
          scriptPanel.appendChild(row);
        });
      }

      // 音色试听:完整旁白 + 提供方信息
      const audio = $("scriptAudio");
      if (audio) {
        const first = segments[0];
        if (first) audio.src = "/assets/voice/" + first.id + ".wav";
        const voiceChecks = document.querySelector('.work-panel[data-work-panel="script"] .check-list');
        if (voiceChecks) {
          voiceChecks.querySelectorAll(".check-item").forEach((el) => el.remove());
          const provider = project.voice?.provider || "未知";
          const items = [
            ["音色提供方", "provider = " + provider + (project.voice?.voiceId ? " · " + project.voice.voiceId : project.voice?.referenceAudio ? " · " + project.voice.referenceAudio : "")],
            ["语速与情绪", "speed " + (project.voice?.speed || 1) + (project.voice?.direction ? " · " + project.voice.direction : "")],
          ];
          items.forEach(([name, detail]) => {
            const item = document.createElement("div");
            item.className = "check-item";
            item.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg><div><strong>' + name + "</strong><span>" + detail + "</span></div>";
            voiceChecks.appendChild(item);
          });
        }
      }

      // ── 场景顺序(storyboard panel)────────────────────────────
      const sceneGrid = document.querySelector('.work-panel[data-work-panel="storyboard"] .scene-grid');
      if (sceneGrid) {
        sceneGrid.replaceChildren();
        scenes.forEach((scene, i) => {
          const card = document.createElement("article");
          card.className = "scene-card" + (i === 0 ? " active" : "");
          card.dataset.sceneId = scene.id;
          card.tabIndex = 0;
          const state = status.state.sceneStates?.[scene.id]?.status || "outline";
          card.innerHTML = '<div class="scene-card-body"><strong>' + String(i + 1).padStart(2, "0") + " · " + (scene.title || scene.id) + "</strong>"
            + "<span>" + fmt(scene.duration) + " 秒 · " + (scene.transitionIn || "cut") + "</span>"
            + '<span class="status ' + (["complete", "approved"].includes(state) ? "success" : "pending") + '" data-scene-state>' + stageStateText(state) + "</span></div>";
          sceneGrid.appendChild(card);
        });
        // 场景选中 → 播放对应渲染
        const player = $("scenePlayer");
        const playBtn = $("playScene");
        const selectScene = (id) => {
          sceneGrid.querySelectorAll(".scene-card").forEach((c) => c.classList.toggle("active", c.dataset.sceneId === id));
          const src = player ? player.querySelector("source") : null;
          if (src) { src.src = "/renders/" + id + ".mp4"; player.load(); }
        };
        sceneGrid.querySelectorAll(".scene-card").forEach((card) => {
          card.addEventListener("click", () => selectScene(card.dataset.sceneId));
          card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") selectScene(card.dataset.sceneId); });
        });
        if (playBtn && player) {
          playBtn.addEventListener("click", () => {
            if (player.paused) player.play().catch(() => {});
            else player.pause();
          });
        }
        if (scenes[0]) selectScene(scenes[0].id);
      }

      // ── 字幕列表(caption panel)────────────────────────────
      const captionPanel = document.querySelector('.work-panel[data-work-panel="caption"] .list-panel');
      if (captionPanel) {
        let captions = [];
        try {
          const raw = await (await fetch("/captions/captions.json", { cache: "no-store" })).json();
          captions = raw.groups || raw;
        } catch { captions = []; }
        captionPanel.querySelectorAll(".content-row").forEach((el) => el.remove());
        const count = captionPanel.querySelector(".list-title .tag");
        if (count) count.textContent = captions.length + " 条";
        captions.forEach((cap, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "content-row" + (i === 0 ? " active" : "");
          row.dataset.captionId = cap.id;
          row.innerHTML = '<span class="row-id">' + String(i + 1).padStart(3, "0") + "</span>"
            + "<div><strong>" + (cap.text || "") + "</strong><small>" + (cap.sceneId || "") + "</small></div>"
            + '<span class="mono muted">' + fmt(cap.start) + "–" + fmt(cap.end) + "</span>";
          captionPanel.appendChild(row);
        });
        // 字幕选中 → 预览 overlay
        const overlay = $("captionOverlay");
        if (overlay) {
          captionPanel.querySelectorAll(".content-row").forEach((row) => {
            row.addEventListener("click", () => {
              captionPanel.querySelectorAll(".content-row").forEach((r) => r.classList.toggle("active", r === row));
              const cap = captions.find((c) => c.id === row.dataset.captionId);
              if (cap) overlay.textContent = cap.text;
            });
          });
        }
      }
    } catch (error) {
      window.showToast("无法连接本地服务：" + error.message + "。请运行 video-harness serve <项目目录> 后访问。", "服务不可用");
    }
  })();
})();
