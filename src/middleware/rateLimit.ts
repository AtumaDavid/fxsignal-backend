import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  hits: number[];
}

/**
 * Minimal in-memory sliding-window rate limiter for abuse-prone routes
 * (auth, explicit refresh). No dependency, per-process state — put a real
 * store (Redis) in front when scaling horizontally.
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();
  // Prevent unbounded growth in long-lived processes.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }, windowMs).unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip ?? 'unknown'}:${req.path}`;
    const now = Date.now();
    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
    if (bucket.hits.length >= maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res
        .status(429)
        .json({ error: 'Too many attempts. Please slow down and retry.' });
    }
    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };
}
