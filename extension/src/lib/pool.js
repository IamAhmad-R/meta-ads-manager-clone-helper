/**
 * Runs `worker` over `items` with at most `limit` in flight. Order of the
 * returned array matches the input. Workers are expected to catch their own
 * errors and return a result row.
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
