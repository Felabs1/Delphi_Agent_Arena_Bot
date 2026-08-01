/**
 * Bounded-concurrency map.
 *
 * Market analysis is embarrassingly parallel — each market's LLM calls and
 * chain reads are independent — but running it sequentially made a six-market
 * pass take over ten minutes on free models, which are slow. That is useless
 * for a five-minute cron.
 *
 * Bounded rather than unbounded because free model tiers rate-limit hard, and
 * firing fifty concurrent requests is the fastest way to get 429'd on all of
 * them. Results keep input order so downstream ranking stays deterministic.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
