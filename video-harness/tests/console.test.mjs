import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createProject } from "../lib/model.mjs";
import { startHarnessServer } from "../lib/server.mjs";

function makeProject() {
  const parent = mkdtempSync(join(tmpdir(), "vh-console-"));
  const root = createProject(join(parent, "project"), { title: "控制台测试", initialText: "测试文案。" });
  const fixtures = [
    ["assets/voice/line-001.wav", "RIFF test wav"],
    ["renders/scene-001.mp4", "fake mp4"],
    ["captions/captions.json", '{"groups":[{"id":"caption-001","sceneId":"scene-001","start":0,"end":1,"text":"测试"}]}'],
    ["delivery/final.mp4", "fake mp4"],
    ["delivery/manifest.json", '{"files":["final.mp4","captions.srt"]}'],
    ["delivery/captions.srt", "1\n00:00:00,000 --> 00:00:01,000\n测试\n"],
  ];
  for (const [rel, content] of fixtures) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

async function withServer(fn) {
  const root = makeProject();
  const server = await startHarnessServer(root, { port: 0 });
  try {
    await fn(server.url);
  } finally {
    await server.close();
  }
}

test("/console/ 提供三页面与共享脚本/CSS", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    for (const [page, type] of [
      ["index.html", "text/html"],
      ["workspace.html", "text/html"],
      ["delivery.html", "text/html"],
      ["console-api.js", "text/javascript"],
      ["console-ui.js", "text/javascript"],
      ["workspace-wiring.js", "text/javascript"],
      ["assets/workbench.css", "text/css"],
    ]) {
      const r = await fetch(base + "/console/" + page);
      assert.equal(r.status, 200, page + " 应可访问");
      assert.ok(String(r.headers.get("content-type") || "").startsWith(type), page + " Content-Type 应为 " + type + ", got " + r.headers.get("content-type"));
    }
    const dir = await fetch(base + "/console/");
    assert.equal(dir.status, 200, "目录请求应回退到 index.html");
  });
});

test("/console/ 缺失资源返回 404(而非 400)", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    const missing = await fetch(base + "/console/assets/missing.css");
    assert.equal(missing.status, 404);
    const missingPage = await fetch(base + "/console/nope.html");
    assert.equal(missingPage.status, 404);
  });
});

test("/console/ 阻止目录穿越", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/console/../lib/server.mjs");
    assert.equal(r.status, 404, "穿越请求应被拒绝");
    const encoded = await fetch(base + "/console/%2e%2e/lib/server.mjs");
    assert.equal(encoded.status, 404);
  });
});

test("项目资源经站点根路径可达", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    const urls = [
      "/assets/voice/line-001.wav",
      "/renders/scene-001.mp4",
      "/captions/captions.json",
      "/delivery/final.mp4",
      "/delivery/captions.srt",
    ];
    for (const url of urls) {
      const r = await fetch(base + url);
      assert.equal(r.status, 200, url + " 应可访问");
    }
  });
});

test("/api/project 返回项目只读信息(含 manifest.files)", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/api/project");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.project && body.project.title, "应包含 project 信息");
    assert.ok(Array.isArray(body.storyboard.scenes), "应包含 storyboard 场景");
    assert.equal(typeof body.delivery.exists, "boolean");
    assert.ok(Array.isArray(body.delivery.manifest?.files), "manifest.files 应为数组");
  });
});

test("三页面不含指向不存在资源的相对路径(破图/破链接防线)", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    for (const page of ["index.html", "workspace.html", "delivery.html"]) {
      const html = await (await fetch(base + "/console/" + page)).text();
      // 不允许出现裸的相对项目资源引用(应为站点根绝对路径或 /console/ 前缀)
      const bad = html.match(/(?:src|href|poster)="(?!\/(?:console|assets|renders|captions|delivery)\/|#|https?:|javascript:)[^"]*assets\//g);
      assert.equal(bad, null, page + " 不应有相对 assets 引用: " + (bad ? bad.join(",") : ""));
      const fakePoster = html.match(/poster="(?!\/)/);
      assert.equal(fakePoster, null, page + " 不应有相对 poster");
    }
  });
});
