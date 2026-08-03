// console-browser.test.mjs — 控制台浏览器布局回归测试(持久化,非一次性脚本)
// 覆盖:五档宽度(1920/1440/1024/785/390)、SVG 尺寸、水平溢出、工作区标签控制、
// 面板可见性、截图差异、三页面几何约束。截图保存到 tests/console-shots/ 供人工检查。
// 依赖:本机 Chrome + puppeteer-core(优先全局/本地,其次 .codex 缓存);不可用时跳过。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../lib/model.mjs";
import { startHarnessServer } from "../lib/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(HERE, "console-shots");

function resolvePuppeteer() {
  try {
    return require("puppeteer-core");
  } catch {
    try {
      return require(join(HERE, "..", "..", ".codex", "npm-cache", "_npx", "4d6048b58950d0e2", "node_modules", "puppeteer-core"));
    } catch {
      return null;
    }
  }
}
const resolveChrome = () => {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const fs = require("node:fs");
  return candidates.find((c) => fs.existsSync(c)) || null;
};

const puppeteer = resolvePuppeteer();
const chromePath = resolveChrome();
const haveBrowser = Boolean(puppeteer && chromePath);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

test("浏览器布局回归:五档宽度、SVG 约束、标签控制、截图差异", { timeout: 180_000, skip: !haveBrowser && "本机无 puppeteer-core 或 Chrome,跳过浏览器测试" }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "vh-browser-"));
  const root = createProject(join(parent, "project"), { title: "浏览器回归测试", initialText: "测试文案。" });
  const server = await startHarnessServer(root, { port: 0 });
  const base = server.url;
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
  mkdirSync(SHOT_DIR, { recursive: true });

  const widths = [1920, 1440, 1024, 785, 390];
  const summaries = {};

  try {
    for (const width of widths) {
      const height = width < 800 ? 900 : 1080;
      const page = await browser.newPage();
      await page.setViewport({ width, height });
      const entry = { width, pages: {} };
      for (const file of ["index.html", "workspace.html", "delivery.html"]) {
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(base + "/console/" + file, { waitUntil: "networkidle0", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200));
        const report = await page.evaluate(() => {
          const doc = document.scrollingElement || document.documentElement;
          const overflowX = doc.scrollWidth > window.innerWidth + 1;
          const hugeSvgs = Array.from(document.querySelectorAll("svg")).filter((svg) => {
            const rect = svg.getBoundingClientRect();
            const inMedia = svg.closest("video, .media-preview, .delivery-video, .cover-placeholder");
            return !inMedia && (rect.width > 64 || rect.height > 64);
          }).map((svg) => Math.round(svg.getBoundingClientRect().width) + "x" + Math.round(svg.getBoundingClientRect().height));
          const identity = document.querySelector(".project-identity");
          const track = document.querySelector(".progress-track");
          return {
            overflowX,
            bodyHeight: doc.scrollHeight,
            hugeSvgs,
            identityDisplay: identity ? getComputedStyle(identity).display : null,
            trackDisplay: track ? getComputedStyle(track).display : null,
            activePanels: document.querySelectorAll(".work-panel.active").length,
            ariaSelectedTabs: document.querySelectorAll('.tab[aria-selected="true"]').length,
            panelVisible: (() => {
              const p = document.querySelector(".work-panel.active");
              return p ? getComputedStyle(p).display : null;
            })(),
          };
        });
        entry.pages[file] = { ...report, pageErrors: errors };
        if (width === 1920 || (file === "index.html" && width === 785)) {
          const shot = join(SHOT_DIR, `accept-${width}-${file.replace(".html", "")}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          entry.pages[file].shot = shot;
        }
        page.removeAllListeners("pageerror");
      }
      await page.close();
      summaries[width] = entry;
    }

    // ── 断言 ──
    for (const [width, entry] of Object.entries(summaries)) {
      for (const [file, rep] of Object.entries(entry.pages)) {
        assert.equal(rep.overflowX, false, `${width}px ${file} 不应水平溢出`);
        assert.deepEqual(rep.hugeSvgs, [], `${width}px ${file} 不应有超大非媒体 SVG: ${rep.hugeSvgs.join(",")}`);
        assert.deepEqual(rep.pageErrors, [], `${width}px ${file} 无页面错误`);
        assert.ok(rep.bodyHeight > 500, `${width}px ${file} 高度应合理(>500), got ${rep.bodyHeight}`);
        assert.ok(rep.bodyHeight < 30000, `${width}px ${file} 高度不应异常爆炸, got ${rep.bodyHeight}`);
      }
    }
    // 桌面档几何
    const d1920 = summaries[1920].pages;
    assert.ok(["grid", "flex"].includes(d1920["index.html"].identityDisplay), "总览 .project-identity 应为 grid/flex, got " + d1920["index.html"].identityDisplay);
    assert.equal(d1920["index.html"].trackDisplay, "grid", "总览 .progress-track 应为 grid");
    // 工作区:恰好一个 active 面板 + 一个 aria-selected
    assert.equal(d1920["workspace.html"].activePanels, 1, "工作区应恰好一个 .work-panel.active");
    assert.equal(d1920["workspace.html"].ariaSelectedTabs, 1, "工作区应恰好一个 aria-selected tab");
    assert.equal(d1920["workspace.html"].panelVisible, "block", "活动面板应可见(display:block)");
    // 交付页 SVG
    assert.ok(Array.isArray(d1920["delivery.html"].hugeSvgs));

    // ── 工作区标签切换:project → storyboard 可见性 + 截图哈希不同 ──
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(base + "/console/workspace.html?stage=project", { waitUntil: "networkidle0", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1200));
      const before = await page.evaluate(() => {
        const p = document.querySelector('.work-panel[data-work-panel="project"]');
        const s = document.querySelector('.work-panel[data-work-panel="storyboard"]');
        return {
          projectVisible: p ? getComputedStyle(p).display !== "none" : false,
          storyboardVisible: s ? getComputedStyle(s).display !== "none" : false,
          title: document.getElementById("workspaceStageTitle") ? document.getElementById("workspaceStageTitle").textContent : null,
        };
      });
      await page.evaluate(() => {
        const tab = document.querySelector('.tab[data-workspace-tab="storyboard"]');
        if (tab) tab.click();
      });
      await new Promise((r) => setTimeout(r, 800));
      const after = await page.evaluate(() => {
        const p = document.querySelector('.work-panel[data-work-panel="project"]');
        const s = document.querySelector('.work-panel[data-work-panel="storyboard"]');
        return {
          projectVisible: p ? getComputedStyle(p).display !== "none" : false,
          storyboardVisible: s ? getComputedStyle(s).display !== "none" : false,
          title: document.getElementById("workspaceStageTitle") ? document.getElementById("workspaceStageTitle").textContent : null,
          urlStage: new URLSearchParams(location.search).get("stage"),
        };
      });
      const shotBefore = await page.screenshot({ fullPage: true });
      await page.evaluate(() => {
        const tab = document.querySelector('.tab[data-workspace-tab="project"]');
        if (tab) tab.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      const shotProject = await page.screenshot({ fullPage: true });
      assert.equal(before.projectVisible, true, "初始 project 面板应可见");
      assert.equal(before.storyboardVisible, false, "初始 storyboard 面板应隐藏");
      assert.equal(after.projectVisible, false, "切到 storyboard 后 project 面板应隐藏");
      assert.equal(after.storyboardVisible, true, "切到 storyboard 后分镜面板应可见");
      assert.equal(after.title, "分镜与视觉", "标题应同步为分镜与视觉");
      assert.equal(after.urlStage, "storyboard", "URL 查询参数应更新为 stage=storyboard");
      assert.notEqual(sha256(shotProject), sha256(shotBefore), "project 与 storyboard 截图哈希不得相同");
      // ?stage=storyboard 直接打开也应生效
      const page2 = await browser.newPage();
      await page2.setViewport({ width: 1920, height: 1080 });
      await page2.goto(base + "/console/workspace.html?stage=review", { waitUntil: "networkidle0", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1200));
      const direct = await page2.evaluate(() => {
        const rp = document.querySelector('.work-panel[data-work-panel="review"]');
        return rp ? getComputedStyle(rp).display !== "none" : false;
      });
      assert.equal(direct, true, "?stage=review 直接打开应显示审阅面板");
      await page2.close();
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log("截图目录:", SHOT_DIR);
});
