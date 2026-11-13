'use strict';

// Bounded per-process brute-force protection. Shared deployments need a shared store.
function createLoginLimiter({ limit = 20, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, value] of buckets) if (time - value.start >= windowMs) buckets.delete(key);
    const key = req.ip;
    const bucket = buckets.get(key) || { start: time, count: 0 };
    if (bucket.count >= limit || (!buckets.has(key) && buckets.size >= 10000)) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowMs - (time - bucket.start)) / 1000))));
      return res.status(429).send('Too many login attempts. Try again later.');
    }
    bucket.count++;
    buckets.set(key, bucket);
    next();
  };
}
module.exports = { createLoginLimiter };
