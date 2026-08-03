import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/video-harness.mjs", import.meta.url));

test("CLI 帮助可直接运行", () => {
  const result = spawnSync(process.execPath, [entry, "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /项目本地视频产品内核/);
  assert.match(result.stdout, /audio.*--mock/s);
});

test("CLI advance 会返回当前质量门", () => {
  const root = join(mkdtempSync(join(tmpdir(), "video-harness-cli-")), "project");
  const initialized = spawnSync(
    process.execPath,
    [entry, "init", root, "--text", "CLI 流水线测试。", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const advanced = spawnSync(
    process.execPath,
    [entry, "advance", root, "--mock-audio", "--mock-render", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(advanced.status, 0, advanced.stderr);
  const result = JSON.parse(advanced.stdout);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.stage, "script");
});
