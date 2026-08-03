export const SCHEMA_VERSION = 1;

export const STAGES = [
  "setup",
  "script",
  "audio",
  "storyboard",
  "design",
  "scenes",
  "captions",
  "review",
  "render",
  "delivery",
];

export const STAGE_DEPENDENCIES = {
  setup: [],
  script: ["setup"],
  audio: ["script"],
  storyboard: ["audio"],
  design: ["setup"],
  scenes: ["storyboard", "design"],
  captions: ["audio", "storyboard", "design"],
  review: ["scenes", "captions"],
  render: ["review"],
  delivery: ["render"],
};

export const STAGE_STATUSES = [
  "pending",
  "ready",
  "running",
  "needs_approval",
  "approved",
  "complete",
  "stale",
  "failed",
];

export const DEFAULT_APPROVALS = ["script", "storyboard", "review"];

export const PROJECT_FILES = {
  project: "project.json",
  script: "script.json",
  voice: "voice-profile.json",
  design: "design.json",
  storyboard: "storyboard.json",
  audioRequest: "audio_request.json",
  audioMeta: "audio_meta.json",
  state: ".harness/state.json",
  approvals: ".harness/approvals.json",
  revisions: "reviews/revisions.json",
  captionGroups: "captions/captions.json",
  captionsSrt: "captions/captions.srt",
  captionsVtt: "captions/captions.vtt",
  captionsAss: "captions/captions.ass",
  captionOverrides: "caption-overrides.json",
  narration: "assets/voice/narration.wav",
  reviewManifest: "reviews/review-manifest.json",
  reviewHtml: "reviews/index.html",
  editHtml: "edit.html",
};

export const GENERATED_FILES = ["BRIEF.md", "SCRIPT.md", "frame.md", "STORYBOARD.md"];

export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
