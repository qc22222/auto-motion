import { join } from "node:path";
import {
  DEFAULT_APPROVALS,
  PROJECT_FILES,
  SCHEMA_VERSION,
  STAGES,
  STAGE_DEPENDENCIES,
} from "./constants.mjs";
import { nowIso, readJson, writeJson } from "./fs-utils.mjs";

function emptyStage() {
  return {
    status: "pending",
    updatedAt: null,
    inputHash: null,
    outputHash: null,
    error: null,
  };
}

export function createState(mode = "review") {
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, emptyStage()]));
  stages.setup = { ...emptyStage(), status: "complete", updatedAt: nowIso() };
  stages.script.status = "ready";
  stages.design.status = "ready";
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    updatedAt: nowIso(),
    stages,
    sceneStates: {},
  };
}

export function loadState(projectRoot) {
  return readJson(join(projectRoot, PROJECT_FILES.state));
}

export function saveState(projectRoot, state) {
  state.updatedAt = nowIso();
  writeJson(join(projectRoot, PROJECT_FILES.state), state);
}

export function createApprovals(required = DEFAULT_APPROVALS) {
  return {
    schemaVersion: SCHEMA_VERSION,
    required,
    records: {},
    updatedAt: nowIso(),
  };
}

export function loadApprovals(projectRoot) {
  return readJson(join(projectRoot, PROJECT_FILES.approvals));
}

export function saveApprovals(projectRoot, approvals) {
  approvals.updatedAt = nowIso();
  writeJson(join(projectRoot, PROJECT_FILES.approvals), approvals);
}

export function setStage(projectRoot, stage, status, details = {}) {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`);
  const state = loadState(projectRoot);
  state.stages[stage] = {
    ...state.stages[stage],
    ...details,
    status,
    updatedAt: nowIso(),
    error: details.error ?? (status === "failed" ? state.stages[stage].error : null),
  };
  saveState(projectRoot, state);
  return state.stages[stage];
}

export function setSceneStage(projectRoot, sceneId, status, details = {}) {
  const state = loadState(projectRoot);
  state.sceneStates[sceneId] = {
    ...state.sceneStates[sceneId],
    ...details,
    status,
    updatedAt: nowIso(),
    error: details.error ?? (status === "failed" ? state.sceneStates[sceneId]?.error ?? null : null),
  };
  saveState(projectRoot, state);
  return state.sceneStates[sceneId];
}

export function approve(projectRoot, stage, note = "") {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`);
  const state = loadState(projectRoot);
  const status = state.stages[stage]?.status;
  if (!["needs_approval", "complete", "approved"].includes(status)) {
    throw new Error(`阶段 ${stage} 当前状态为 ${status ?? "unknown"}，不能批准`);
  }
  const approvals = loadApprovals(projectRoot);
  if (!approvals.required.includes(stage)) approvals.required.push(stage);
  approvals.records[stage] = {
    approvedAt: nowIso(),
    note,
  };
  saveApprovals(projectRoot, approvals);
  if (state.stages[stage]) {
    state.stages[stage].status = "approved";
    state.stages[stage].updatedAt = nowIso();
    saveState(projectRoot, state);
  }
  return approvals.records[stage];
}

export function isApproved(projectRoot, stage) {
  const approvals = loadApprovals(projectRoot);
  return Boolean(approvals.records[stage]?.approvedAt);
}

export function requireApproval(projectRoot, stage, force = false) {
  if (force) return;
  const state = loadState(projectRoot);
  if (state.mode === "automation" && stage !== "review") return;
  const approvals = loadApprovals(projectRoot);
  if (!approvals.required.includes(stage)) return;
  if (!approvals.records[stage]?.approvedAt) {
    throw new Error(`阶段尚未批准：${stage}。请先执行 approve ${stage}`);
  }
}

export function requireStage(projectRoot, stage, allowed = ["complete", "approved"]) {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`);
  const state = loadState(projectRoot);
  const status = state.stages[stage]?.status;
  if (!allowed.includes(status)) {
    throw new Error(`阶段 ${stage} 尚未完成，当前状态：${status ?? "unknown"}`);
  }
}

export function dependentStages(stage) {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`);
  const result = new Set([stage]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of STAGES) {
      if (result.has(current)) continue;
      if ((STAGE_DEPENDENCIES[current] || []).some((dependency) => result.has(dependency))) {
        result.add(current);
        changed = true;
      }
    }
  }
  return STAGES.filter((current) => result.has(current));
}

export function invalidateStages(projectRoot, stages, options = {}) {
  const requested = Array.isArray(stages) ? stages : [stages];
  const unknown = requested.filter((stage) => !STAGES.includes(stage));
  if (unknown.length > 0) throw new Error(`未知阶段：${unknown.join("、")}`);
  const affected = STAGES.filter((stage) => requested.includes(stage));
  const state = loadState(projectRoot);
  for (const current of affected) {
    if (current === "setup") continue;
    state.stages[current].status = "stale";
    state.stages[current].updatedAt = nowIso();
  }
  const sceneIds = options.allScenes
    ? Object.keys(state.sceneStates)
    : [...new Set((options.sceneIds || []).filter(Boolean))];
  for (const sceneId of sceneIds) {
    state.sceneStates[sceneId] = {
      ...(state.sceneStates[sceneId] || {}),
      status: "stale",
      updatedAt: nowIso(),
    };
  }
  saveState(projectRoot, state);

  const approvals = loadApprovals(projectRoot);
  let approvalsChanged = false;
  for (const current of affected) {
    if (approvals.records[current]) {
      delete approvals.records[current];
      approvalsChanged = true;
    }
  }
  if (approvalsChanged) saveApprovals(projectRoot, approvals);
  return { state, affected, sceneIds };
}

export function invalidateFrom(projectRoot, stage, sceneId = null) {
  const affected = dependentStages(stage);
  return invalidateStages(projectRoot, affected, {
    allScenes: !sceneId && affected.includes("scenes"),
    sceneIds: sceneId ? [sceneId] : [],
  }).state;
}
