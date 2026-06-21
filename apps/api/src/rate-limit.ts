export interface SlidingWindowRateLimiter {
  allow: (now?: number) => boolean;
  reset: () => void;
}

export function createSlidingWindowRateLimiter({
  max,
  windowMs,
}: {
  max: number;
  windowMs: number;
}): SlidingWindowRateLimiter {
  const hits: number[] = [];
  return {
    allow(now = Date.now()) {
      while (true) {
        const oldest = hits[0];
        if (oldest === undefined || now - oldest < windowMs) break;
        hits.shift();
      }
      if (hits.length >= max) return false;
      hits.push(now);
      return true;
    },
    reset() {
      hits.length = 0;
    },
  };
}
