/** In-memory sliding-window limiter: at most `limit` hits per key within `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records a hit and returns true, or returns false (without recording) when the key is over its budget. */
  hit(key: string): boolean {
    const t = this.now();
    const from = t - this.windowMs;
    const times = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (times.length >= this.limit) {
      this.hits.set(key, times);
      return false;
    }
    times.push(t);
    this.hits.set(key, times);
    return true;
  }

  /** Drops keys with no hits inside the window; call periodically so the map stays bounded. */
  sweep(): void {
    const from = this.now() - this.windowMs;
    for (const [k, times] of this.hits) {
      if (!times.some((x) => x > from)) this.hits.delete(k);
    }
  }
}
