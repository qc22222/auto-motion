// workspace-tabs.js — 工作区五标签控制器(2026-08-03 补:原 demo workbench.js 被替换后缺失)
// 职责:?stage 初始化、点击/键盘切换、面板/检查器/标题同步、replaceState 更新查询参数。
(() => {
  "use strict";
  const TABS = ["project", "script", "storyboard", "caption", "review"];
  const tabButtons = Array.from(document.querySelectorAll(".tab[data-workspace-tab]"));
  const titleEl = document.getElementById("workspaceStageTitle");
  const titleByTab = {};
  tabButtons.forEach((b) => { titleByTab[b.dataset.workspaceTab] = b.dataset.title || b.dataset.workspaceTab; });

  function activate(tab, updateUrl) {
    if (!TABS.includes(tab)) tab = "project";
    tabButtons.forEach((b) => {
      const active = b.dataset.workspaceTab === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
      b.setAttribute("tabindex", active ? "0" : "-1");
    });
    TABS.forEach((t) => {
      const panel = document.querySelector('.work-panel[data-work-panel="' + t + '"]');
      if (panel) panel.classList.toggle("active", t === tab);
      const insp = document.querySelector('[data-inspector-panel="' + t + '"]');
      if (insp) insp.hidden = t !== tab;
    });
    if (titleEl) titleEl.textContent = titleByTab[tab] || tab;
    if (updateUrl) {
      const url = new URL(location.href);
      if (tab === "project") url.searchParams.delete("stage");
      else url.searchParams.set("stage", tab);
      history.replaceState(null, "", url.pathname + url.search);
    }
  }

  // 初始:?stage= 解析(非法/缺失默认 project;初始化必须立即显示一个面板)
  const params = new URLSearchParams(location.search);
  const initial = params.get("stage");
  activate(TABS.includes(initial) ? initial : "project", false);

  // 点击与键盘(方向键循环 + Enter/Space 激活)
  tabButtons.forEach((b, idx) => {
    b.addEventListener("click", () => activate(b.dataset.workspaceTab, true));
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const nextIdx = e.key === "ArrowRight"
          ? (idx + 1) % TABS.length
          : (idx - 1 + TABS.length) % TABS.length;
        activate(TABS[nextIdx], true);
        const nextBtn = tabButtons[nextIdx];
        if (nextBtn) nextBtn.focus();
        e.preventDefault();
      } else if (e.key === "Enter" || e.key === " ") {
        activate(b.dataset.workspaceTab, true);
        e.preventDefault();
      }
    });
  });
})();
