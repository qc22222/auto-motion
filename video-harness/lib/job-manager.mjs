import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function publicJob(job) {
  return structuredClone(job);
}

export function createJobManager(options = {}) {
  const jobs = new Map();
  const maxRecords = Math.max(5, Number(options.maxRecords) || 50);
  let activeId = null;

  function active() {
    return activeId ? publicJob(jobs.get(activeId)) : null;
  }

  function prune() {
    if (jobs.size <= maxRecords) return;
    for (const [id, job] of jobs) {
      if (id === activeId || !["succeeded", "failed"].includes(job.status)) continue;
      jobs.delete(id);
      if (jobs.size <= maxRecords) return;
    }
  }

  function start(type, input, task) {
    const current = active();
    if (current) {
      throw Object.assign(new Error(`已有任务正在执行：${current.type}（${current.id}）`), { statusCode: 409 });
    }
    const id = randomUUID();
    const job = {
      id,
      type,
      status: "queued",
      input: structuredClone(input || {}),
      result: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    jobs.set(id, job);
    activeId = id;
    setImmediate(async () => {
      job.status = "running";
      job.startedAt = nowIso();
      try {
        job.result = await task();
        job.status = "succeeded";
      } catch (error) {
        job.status = "failed";
        job.error = String(error?.message || error);
      } finally {
        job.completedAt = nowIso();
        if (activeId === id) activeId = null;
        prune();
      }
    });
    return publicJob(job);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? publicJob(job) : null;
  }

  return { active, get, start };
}
