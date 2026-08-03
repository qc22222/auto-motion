import assert from "node:assert/strict";
import test from "node:test";
import { aggregateWhisperTokens } from "./tts.mjs";

// whisper -ojf 的 tokens 格式:offsets 为毫秒,text 含空格/特殊 token
const toks = [
  { text: " [_BEG_]", offsets: { from: 0, to: 0 } },
  { text: "把", offsets: { from: 230, to: 310 } },
  { text: "想法", offsets: { from: 310, to: 620 } },
  { text: "变", offsets: { from: 620, to: 930 } },
  { text: "成", offsets: { from: 930, to: 1220 } },
  { text: "成", offsets: { from: 1220, to: 1510 } },
  { text: "片", offsets: { from: 1510, to: 1800 } },
  { text: "，", offsets: { from: 1800, to: 1900 } },
  { text: "只", offsets: { from: 2000, to: 2290 } },
  { text: "需要", offsets: { from: 2290, to: 2600 } },
  { text: "一", offsets: { from: 2600, to: 2700 } },
  { text: "条", offsets: { from: 2700, to: 2800 } },
  { text: "流水线", offsets: { from: 2800, to: 3300 } },
  { text: "。", offsets: { from: 3300, to: 3400 } },
];

test("聚合中文 tokens:过滤特殊 token,标点并入前词,输出词级时间戳", () => {
  const words = aggregateWhisperTokens(toks);
  assert.equal(words.length, 2, "应为 2 个词(标点处不应单独成词)");
  assert.equal(words[0].text, "把想法变成成片，", "标点应并入前词");
  assert.equal(words[0].start, 0.23);
  assert.equal(words[0].end, 1.9);
  assert.equal(words[1].text, "只需要一条流水线。");
  assert.equal(words[1].start, 2.0);
  assert.equal(words[1].end, 3.4);
});

test("长停顿断开长词,超长词按 maxWordChars 截断", () => {
  const t1 = { text: "甲", offsets: { from: 100, to: 200 } };
  const t2 = { text: "乙", offsets: { from: 900, to: 1000 } }; // 停顿 0.7s
  const words = aggregateWhisperTokens([t1, t2]);
  assert.equal(words.length, 2, "停顿超过 0.35s 应断词");
  const longToks = Array.from({ length: 12 }, (_, i) => ({
    text: "字",
    offsets: { from: i * 100, to: i * 100 + 80 },
  }));
  const longWords = aggregateWhisperTokens(longToks, { maxWordChars: 6 });
  assert.equal(longWords.length, 2, "12 字按每 6 字断成 2 词");
  assert.equal(longWords[0].text.length, 6);
});

test("空输入返回空数组", () => {
  assert.deepEqual(aggregateWhisperTokens([]), []);
  assert.deepEqual(aggregateWhisperTokens(null), []);
  assert.deepEqual(aggregateWhisperTokens([{ text: " [_BEG_]", offsets: { from: 0, to: 0 } }]), []);
});
