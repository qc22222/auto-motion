// console-api.js — OpenDesign 三页面与 video-harness 服务层的共享接线层。
// 原则:只消费 server.mjs 既有接口;写操作一律 preview→apply;长任务走 /api/jobs 轮询;
// 不在前端复制状态机。页面必须通过 `video-harness serve <项目> --port N` 访问。
(function (global) {
  "use strict";

  async function api(path, payload) {
    if (location.protocol === "file:") {
      throw new Error("请运行 video-harness serve <项目目录> 后从本地地址访问，才能安全应用修改。");
    }
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-video-harness": "1" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(function () {
      return { error: "服务返回了无法解析的响应" };
    });
    if (!response.ok) throw new Error(result.error || "请求失败");
    return result;
  }

  async function getJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    const result = await response.json().catch(function () {
      return { error: "服务返回了无法解析的响应" };
    });
    if (!response.ok) throw new Error(result.error || "请求失败");
    return result;
  }

  async function waitForJob(job, onProgress) {
    let current = job;
    while (["queued", "running"].includes(current.status)) {
      if (onProgress) onProgress(current);
      await new Promise(function (resolve) { setTimeout(resolve, 1000); });
      current = await getJson("/api/jobs/" + encodeURIComponent(current.id));
    }
    if (current.status === "failed") throw new Error(current.error || "任务执行失败");
    return current;
  }

  // 阶段展示名与状态样式(与 harness state.mjs 的阶段语义一致)
  var STAGE_LABELS = {
    setup: "项目准备",
    script: "文案",
    audio: "音频",
    storyboard: "分镜",
    design: "设计",
    captions: "字幕",
    scenes: "场景",
    review: "审阅",
    render: "渲染",
    delivery: "交付",
  };

  function stageLabel(stage) {
    return STAGE_LABELS[stage] || stage;
  }

  function stageStatusClass(status) {
    if (["complete", "approved"].includes(status)) return "done";
    if (status === "needs_approval" || status === "ready") return "gate";
    if (status === "failed") return "failed";
    if (status === "running") return "running";
    return "pending";
  }

  // 常用查询:最近更新的项目 JSON(只读端点不存在时前端只渲染已知字段)
  function projectFileUrl(relativePath) {
    return relativePath ? encodeURI(relativePath) : "";
  }

  global.ConsoleApi = {
    api: api,
    getJson: getJson,
    waitForJob: waitForJob,
    stageLabel: stageLabel,
    stageStatusClass: stageStatusClass,
    projectFileUrl: projectFileUrl,
  };
})(window);
