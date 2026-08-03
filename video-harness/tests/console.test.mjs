import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProject } from "../lib/model.mjs";
import { startHarnessServer } from "../lib/server.mjs";

async function withServer(fn) {
  const parent = mkdtempSync(join(tmpdir(), "vh-console-"));
  const root = createProject(join(parent, "project"), { title: "控制台测试", initialText: "测试文案。" });
  const server = await startHarnessServer(root, { port: 0 });
  try {
    await fn(server.url, root);
  } finally {
    await server.close();
  }
}

test("/console/ 提供 OpenDesign 三页面与共享脚本", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    for (const page of ["index.html", "workspace.html", "delivery.html", "console-api.js", "console-ui.js"]) {
      const r = await fetch(base + "/console/" + page);
      assert.equal(r.status, 200, page + " 应可访问");
    }
    const r = await fetch(base + "/console/");
    assert.equal(r.status, 200, "目录请求应回退到 index.html");
  });
});

test("/console/ 阻止目录穿越", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/console/../lib/server.mjs");
    assert.equal(r.status, 404, "穿越请求应被拒绝");
  });
});

test("/api/project 返回项目只读信息", { timeout: 30_000 }, async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/api/project");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.project && body.project.title, "应包含 project 信息");
    assert.ok(Array.isArray(body.storyboard.scenes), "应包含 storyboard 场景");
    assert.equal(typeof body.delivery.exists, "boolean", "应包含 delivery 状态");
  });
});
