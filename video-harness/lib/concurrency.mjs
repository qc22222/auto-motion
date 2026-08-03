// concurrency.mjs — 有界并发执行工具。
// mapWithConcurrency:以最多 limit 个在途任务并发执行 fn,结果数组保持输入顺序。
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}