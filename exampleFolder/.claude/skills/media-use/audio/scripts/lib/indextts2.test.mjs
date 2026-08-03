import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildIndexTts2BatchRows,
  buildIndexTts2Invocation,
  normalizeIndexTts2Settings,
  resolveIndexTts2Runtime,
  runIndexTts2Batch,
} from "./indextts2.mjs";

test("IndexTTS2 运行时固定使用项目本地 Python、单份模型和 CUDA", () => {
  const workspaceRoot = "E:/workspace";
  const existing = new Set([
    "E:/workspace/.codex/runtime/indextts2",
    "E:/workspace/.codex/runtime/indextts2/.venv/Scripts/python.exe",
    "E:/workspace/.codex/runtime/indextts2/.venv/Lib/site-packages",
    "E:/models/indextts2",
  ]);
  const runtime = resolveIndexTts2Runtime({
    workspaceRoot,
    platform: "win32",
    pathExists: (path) => existing.has(path.replaceAll("\\", "/")),
  });
  assert.equal(runtime.python.replaceAll("\\", "/"), "E:/workspace/.codex/runtime/indextts2/.venv/Scripts/python.exe");
  assert.equal(runtime.modelDir.replaceAll("\\", "/"), "E:/models/indextts2");

  const invocation = buildIndexTts2Invocation({
    runtime,
    batchPath: "E:/project/.harness/audio-temp/indextts2-batch.jsonl",
  });
  assert.equal(invocation.cmd, runtime.python);
  assert.deepEqual(invocation.args.slice(0, 4), ["-S", "-m", "indextts.cli_v2", "batch"]);
  assert.ok(invocation.args.includes("cuda:0"));
  assert.ok(invocation.args.includes("--fp16"));
  assert.ok(invocation.args.includes("--no-deepspeed"));
  assert.ok(invocation.args.includes("--no-cuda-kernel"));
  assert.ok(invocation.args.includes("--no-accel"));
  assert.ok(invocation.args.includes("--no-torch-compile"));
});

test("IndexTTS2 批量清单可用逐段演绎说明驱动情绪，同时复用同一参考音频", () => {
  const settings = normalizeIndexTts2Settings({
    emotionMode: "delivery",
    emotionWeight: 0.6,
  });
  const rows = buildIndexTts2BatchRows({
    lines: [
      { id: "line-001", text: "第一段。", delivery: "克制、平静" },
      { id: "line-002", text: "第二段。", delivery: "更坚定、更有力量" },
    ],
    referenceAudio: "E:/project/assets/reference/owner.wav",
    settings,
    outputForLine: (line) => `E:/project/.harness/audio-temp/indextts2/${line.id}.wav`,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].voice, rows[1].voice);
  assert.equal(rows[0].emotion_text, "克制、平静");
  assert.equal(rows[1].emotion_text, "更坚定、更有力量");
  assert.equal(rows[0].emotion_weight, 0.6);
});

test("IndexTTS2 情绪向量必须恰好八维且总和不超过官方 CLI 上限", () => {
  assert.deepEqual(
    normalizeIndexTts2Settings({ emotionMode: "vector", emotionVector: "0,0,0.6,0,0,0,0,0" }).emotionVector,
    [0, 0, 0.6, 0, 0, 0, 0, 0],
  );
  assert.throws(
    () => normalizeIndexTts2Settings({ emotionMode: "vector", emotionVector: "0.5,0.5,0,0,0,0,0,0" }),
    /总和不得超过 0\.8/,
  );
});

test("IndexTTS2 在批量推理前强制执行 CUDA 预检且禁止 CPU 回退", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "indextts2-cuda-guard-"));
  const projectRoot = join(workspaceRoot, "project");
  const sourceRoot = join(workspaceRoot, ".codex", "runtime", "indextts2");
  const python = join(sourceRoot, ".venv", "Scripts", "python.exe");
  const modelDir = join(workspaceRoot, ".codex", "models", "indextts2");
  const referenceAudio = join(projectRoot, "assets", "reference", "owner.wav");
  for (const dir of [join(sourceRoot, ".venv", "Scripts"), join(sourceRoot, ".venv", "Lib", "site-packages"), modelDir, join(projectRoot, "assets", "reference")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(python, "test");
  writeFileSync(referenceAudio, "authorized");
  const calls = [];
  await assert.rejects(
    runIndexTts2Batch({
      lines: [{ id: "line-001", text: "只允许显卡推理。" }],
      hyperframesDir: projectRoot,
      referenceAudio: "assets/reference/owner.wav",
      settings: { emotionMode: "none" },
      outputForLine: () => join(projectRoot, ".harness", "audio-temp", "line-001.wav"),
      runtimeOptions: { workspaceRoot },
    }, {
      spawn: async (command, args) => {
        calls.push({ command, args });
        return { status: 1 };
      },
    }),
    /CUDA 预检失败；已禁止 CPU 推理回退/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["-S", "-c", "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"]);
});
