import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { compileProject } from "../lib/compile.mjs";
import { readJson } from "../lib/fs-utils.mjs";
import { createProject } from "../lib/model.mjs";
import { startHarnessServer } from "../lib/server.mjs";
import { approve } from "../lib/state.mjs";

function requestHeaders(url) {
  return {
    "content-type": "application/json",
    "x-video-harness": "1",
    origin: new URL(url).origin,
  };
}

async function postJson(instance, path, body = {}) {
  return fetch(`${instance.url}${path}`, {
    method: "POST",
    headers: requestHeaders(instance.url),
    body: JSON.stringify(body),
  });
}

async function waitForJob(instance, jobId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${instance.url}/api/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200);
    const job = await response.json();
    if (["succeeded", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待任务超时：${jobId}`);
}

test("本地工作台提供分环节修改、影响预览和确认应用接口", { timeout: 60_000 }, async () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "harness-server-")), "project"), {
    initialText: "本地修改服务测试。",
  });
  compileProject(root);
  const instance = await startHarnessServer(root, { port: 0 });
  try {
    const page = await fetch(`${instance.url}/edit?target=script&id=line-001`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /分环节修改工作台/);
    assert.match(html, /预览影响/);
    assert.match(html, /确认应用/);
    assert.match(html, /推进到下一质量门/);
    assert.match(html, /批准当前质量门/);
    assert.match(html, /生成或返工当前镜头/);
    assert.match(html, /提交局部意见/);
    assert.match(html, /音频与背景音乐生产预检/);
    assert.match(html, /重新检查生产条件/);
    assert.match(html, /强制重生成本段配音/);
    assert.match(html, /voice-preview/);
    const inlineScript = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Script(inlineScript));

    const catalogResponse = await fetch(`${instance.url}/api/edit/catalog`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.sections.length, 8);

    const blocked = await fetch(`${instance.url}/api/edit/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "script", id: "line-001", changes: { text: "不应生效" } }),
    });
    assert.equal(blocked.status, 403);

    const request = { target: "script", id: "line-001", changes: { text: "已通过工作台精修。" } };
    const previewResponse = await fetch(`${instance.url}/api/edit/preview`, {
      method: "POST",
      headers: requestHeaders(instance.url),
      body: JSON.stringify(request),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.ok(preview.fingerprint);
    assert.ok(preview.impact.stages.includes("audio"));

    const applyResponse = await fetch(`${instance.url}/api/edit/apply`, {
      method: "POST",
      headers: requestHeaders(instance.url),
      body: JSON.stringify({ ...request, expectedFingerprint: preview.fingerprint }),
    });
    assert.equal(applyResponse.status, 200);
    const applied = await applyResponse.json();
    assert.equal(applied.changed, true);
    assert.equal(readJson(join(root, "script.json")).segments[0].text, "已通过工作台精修。");
  } finally {
    await instance.close();
  }
});

test("本地工作台可强制重生成单段配音并直接试听产物", { timeout: 60_000 }, async () => {
  const root = createProject(join(mkdtempSync(join(tmpdir(), "harness-audio-regenerate-")), "project"), {
    initialText: "单段配音试听测试。",
  });
  compileProject(root);
  approve(root, "script");
  const instance = await startHarnessServer(root, {
    port: 0,
    pipelineOptions: { mockAudio: true },
  });
  try {
    const invalid = await postJson(instance, "/api/audio/regenerate", { segmentId: "missing-line" });
    assert.equal(invalid.status, 400);

    const response = await postJson(instance, "/api/audio/regenerate", { segmentId: "line-001" });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    const job = await waitForJob(instance, accepted.job.id);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.result.segmentId, "line-001");

    const audio = await fetch(`${instance.url}/assets/voice/line-001.wav`, { method: "HEAD" });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
  } finally {
    await instance.close();
  }
});

test("本地工作台可安全推进、审批、生成单镜头并提交局部意见", { timeout: 60_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-control-"));
  const root = createProject(join(parent, "project"), {
    initialText: "本地控制服务测试。",
  });
  compileProject(root);
  const runner = join(parent, "stub-scene-runner.mjs");
  writeFileSync(
    runner,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const requestPath = process.argv[process.argv.indexOf("--request") + 1];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
await new Promise((resolve) => setTimeout(resolve, 200));
mkdirSync(dirname(request.outputSource), { recursive: true });
writeFileSync(request.outputSource, '<!doctype html><main data-composition-id="main" data-duration="' + request.duration + '" data-width="' + request.width + '" data-height="' + request.height + '"></main><script>window.__timelines = {};</script>');
`,
    "utf8",
  );
  const instance = await startHarnessServer(root, {
    port: 0,
    pipelineOptions: {
      mockAudio: true,
      mockRender: true,
      allowMockAudio: true,
      runner,
      echo: false,
    },
    generationOptions: { runner, echo: false },
  });
  try {
    const readinessResponse = await fetch(`${instance.url}/api/audio/readiness`);
    assert.equal(readinessResponse.status, 200);
    const readiness = await readinessResponse.json();
    assert.equal(readiness.provider, "heygen");
    assert.equal(readiness.ready, false);

    const firstAdvanceResponse = await postJson(instance, "/api/pipeline/advance");
    assert.equal(firstAdvanceResponse.status, 202);
    const firstAdvance = await firstAdvanceResponse.json();
    const firstJob = await waitForJob(instance, firstAdvance.job.id);
    assert.equal(firstJob.status, "succeeded");
    assert.equal(firstJob.result.stage, "script");

    const rejectedApproval = await postJson(instance, "/api/stages/approve", { stage: "audio" });
    assert.equal(rejectedApproval.status, 400);

    const scriptApproval = await postJson(instance, "/api/stages/approve", {
      stage: "script",
      note: "工作台测试批准",
    });
    assert.equal(scriptApproval.status, 200);

    const secondAdvanceResponse = await postJson(instance, "/api/pipeline/advance");
    assert.equal(secondAdvanceResponse.status, 202);
    const secondAdvance = await secondAdvanceResponse.json();
    const secondJob = await waitForJob(instance, secondAdvance.job.id);
    assert.equal(secondJob.status, "succeeded");
    assert.equal(secondJob.result.stage, "storyboard");

    const storyboardApproval = await postJson(instance, "/api/stages/approve", { stage: "storyboard" });
    assert.equal(storyboardApproval.status, 200);

    const generateResponse = await postJson(instance, "/api/scenes/generate", { sceneId: "scene-001" });
    assert.equal(generateResponse.status, 202);
    const generation = await generateResponse.json();
    const blockedComment = await postJson(instance, "/api/review/comments", {
      sceneId: "scene-001",
      text: "不应与生成任务并发写入。",
    });
    assert.equal(blockedComment.status, 409);
    const generationJob = await waitForJob(instance, generation.job.id);
    assert.equal(generationJob.status, "succeeded", generationJob.error);
    assert.equal(generationJob.result[0].sceneId, "scene-001");

    const commentResponse = await postJson(instance, "/api/review/comments", {
      sceneId: "scene-001",
      pass: "final",
      text: "标题再放大一些，只返工当前镜头。",
    });
    assert.equal(commentResponse.status, 200);
    const comment = await commentResponse.json();
    assert.equal(comment.sceneId, "scene-001");

    const statusResponse = await fetch(`${instance.url}/api/status`);
    const status = await statusResponse.json();
    assert.equal(status.activeJob, null);
    assert.equal(status.state.sceneStates["scene-001"].status, "needs_revision");
  } finally {
    await instance.close();
  }
});
