const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PUNCTUATION_RE = /^[\p{P}\p{S}]+$/u;

export function round3(value) {
  return Number(Number(value).toFixed(3));
}

export function tokenizeSpeech(text, language = "zh-CN") {
  const source = String(text || "").trim();
  if (!source) return [];
  const segmenter = new Intl.Segmenter(language, { granularity: "word" });
  const tokens = [];
  for (const item of segmenter.segment(source)) {
    const token = item.segment.trim();
    if (!token) continue;
    if (PUNCTUATION_RE.test(token) && tokens.length > 0) {
      tokens[tokens.length - 1] += token;
    } else {
      tokens.push(token);
    }
  }
  return tokens.length > 0 ? tokens : [source];
}

function tokenWeight(token) {
  const chars = [...token];
  const cjkCount = chars.filter((char) => CJK_RE.test(char)).length;
  if (cjkCount > 0) return Math.max(1, cjkCount * 0.9);
  return Math.max(1, Math.min(3.4, token.replace(/[^\p{L}\p{N}]/gu, "").length * 0.22));
}

export function estimateSpeech(text, options = {}) {
  const speed = Math.max(0.5, Math.min(2, Number(options.speed) || 1));
  const language = options.language || "zh-CN";
  const tokens = tokenizeSpeech(text, language);
  const weights = tokens.map(tokenWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const punctuationCount = [...String(text || "")].filter((char) => /[，。！？；：,.!?;:]/u.test(char)).length;
  const baseDuration = Math.max(0.55, totalWeight * 0.24 + punctuationCount * 0.06);
  const duration = round3(baseDuration / speed);
  let cursor = 0;
  const words = tokens.map((token, index) => {
    const share = totalWeight > 0 ? weights[index] / totalWeight : 1 / tokens.length;
    const tokenDuration = index === tokens.length - 1 ? duration - cursor : duration * share;
    const start = round3(cursor);
    const end = round3(Math.min(duration, cursor + tokenDuration));
    cursor = end;
    return { id: `w${index}`, text: token, start, end };
  });
  if (words.length > 0) words[words.length - 1].end = duration;
  return { duration, words };
}

export function formatTimestamp(seconds, separator = ",") {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

export function formatSeconds(value) {
  return `${round3(value)}s`;
}
