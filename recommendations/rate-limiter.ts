/**
 * @file rate-limiter.ts
 * @description Fixed-window rate limiter with Redis backing (atomic Lua script)
 * and an in-process fallback when Redis is unavailable.
 *
 * ── Distributed Architecture & Fallback Semantics ────────────────────────────
 * • Redis-Backed Mode (Distributed):
 *   Executes an atomic Lua script that increments the key and fetches remaining
 *   TTL via PTTL in a single round-trip. This ensures race-free counter updates
 *   across multiple application instances.
 * • In-Memory Fallback Mode (Process-Local):
 *   When Redis is unavailable, the middleware falls back to an in-memory Map.
 *   CRITICAL LIMITATION: The fallback is strictly process-local. It does NOT
 *   provide globally consistent rate limiting across multiple Node.js instances
 *   or serverless invocations. An attacker could consume the full threshold on
 *   each replica independently. This fallback favors availability over strictness.
 * • Express Reverse-Proxy Trust:
 *   Derives client IP via Express req.ip. The hosting application must configure
 *   app.set('trust proxy', N) according to its network topology to prevent IP spoofing.
 * • Standard Headers:
 *   - HTTP 429 status: RFC 6585
 *   - RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset: RFC 9333
 *   - Retry-After: RFC 6585
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Request, Response, NextFunction } from 'express';

// ──────────────────────────────────────────────────────────────────────────────
// Redis Adapter Interfaces & Concrete Implementations
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Return format from the atomic fixed-window Lua script.
 * [currentCount, remainingPttlMs]
 */
export type RedisLuaResult = [count: number, remainingTtlMs: number];

/**
 * Adapter interface separating client-specific command signatures
 * (e.g., ioredis vs. node-redis) from rate-limiting logic.
 */
export interface RedisRateLimitAdapter {
  evalFixedWindow(key: string, windowMs: number): Promise<RedisLuaResult>;
  isReady(): boolean;
}

/**
 * Minimal legacy/generic interface for custom clients or mock test suites.
 */
export interface GenericRedisClientLike {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  isReady?: boolean;
  isOpen?: boolean;
}

export type RedisClientOption = RedisRateLimitAdapter | GenericRedisClientLike;

/**
 * Creates a rate limit adapter for `ioredis` client instances.
 */
export function createIoRedisAdapter(ioredisClient: {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  status?: string;
}): RedisRateLimitAdapter {
  return {
    async evalFixedWindow(key: string, windowMs: number): Promise<RedisLuaResult> {
      const res = await ioredisClient.eval(FIXED_WINDOW_LUA, 1, key, windowMs);
      if (Array.isArray(res) && res.length >= 2) {
        return [Number(res[0]), Number(res[1])];
      }
      throw new Error(`Unexpected ioredis return format: ${JSON.stringify(res)}`);
    },
    isReady(): boolean {
      return ioredisClient.status === 'ready';
    },
  };
}

/**
 * Creates a rate limit adapter for `node-redis` (v4+) client instances.
 */
export function createNodeRedisAdapter(nodeRedisClient: {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  isReady?: boolean;
  isOpen?: boolean;
}): RedisRateLimitAdapter {
  return {
    async evalFixedWindow(key: string, windowMs: number): Promise<RedisLuaResult> {
      const res = await nodeRedisClient.eval(FIXED_WINDOW_LUA, {
        keys: [key],
        arguments: [String(windowMs)],
      });
      if (Array.isArray(res) && res.length >= 2) {
        return [Number(res[0]), Number(res[1])];
      }
      throw new Error(`Unexpected node-redis return format: ${JSON.stringify(res)}`);
    },
    isReady(): boolean {
      return nodeRedisClient.isReady ?? nodeRedisClient.isOpen ?? false;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Atomic Redis Lua Script (Fixed-Window)
// Atomically increments key, sets PEXPIRE on first write, and queries PTTL.
// Returns: { current_count, remaining_pttl_in_ms }
// ──────────────────────────────────────────────────────────────────────────────
export const FIXED_WINDOW_LUA = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local cnt = redis.call('INCR', key)
if cnt == 1 then
  redis.call('PEXPIRE', key, windowMs)
end
local ttl = redis.call('PTTL', key)
if ttl < 0 then
  redis.call('PEXPIRE', key, windowMs)
  ttl = redis.call('PTTL', key)
end
return { cnt, ttl }
`;

// ──────────────────────────────────────────────────────────────────────────────
// Options & Result Types
// ──────────────────────────────────────────────────────────────────────────────
export interface RateLimiterOptions {
  /** Duration of counting window in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted per window per key. */
  maxRequests: number;
  /** Custom error message on HTTP 429. */
  message?: string;
  /** Key generation strategy. Defaults to req.ip. */
  keyGenerator?: (req: Request) => string;
  /** Optional filter to skip rate limiting on matching requests. */
  skip?: (req: Request) => boolean;
  /** Optional Redis adapter or client instance. */
  redis?: RedisClientOption;
}

export interface RateLimitCheckResult {
  count: number;
  remaining: number;
  resetSeconds: number;
  remainingTtlMs: number;
  isLimited: boolean;
  usingFallback: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Process-Local In-Memory Fallback Store
// ──────────────────────────────────────────────────────────────────────────────
interface Bucket {
  count: number;
  expiresAt: number;
}

class InProcessStore {
  private readonly map = new Map<string, Bucket>();

  constructor() {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.map) {
        if (bucket.expiresAt <= now) this.map.delete(key);
      }
    }, 60_000);
    if (timer.unref) timer.unref();
  }

  increment(key: string, windowMs: number): { count: number; resetAt: number; remainingTtlMs: number } {
    const now = Date.now();
    const existing = this.map.get(key);

    if (!existing || existing.expiresAt <= now) {
      const bucket: Bucket = { count: 1, expiresAt: now + windowMs };
      this.map.set(key, bucket);
      return { count: 1, resetAt: bucket.expiresAt, remainingTtlMs: windowMs };
    }

    existing.count += 1;
    const remainingTtlMs = Math.max(0, existing.expiresAt - now);
    return { count: existing.count, resetAt: existing.expiresAt, remainingTtlMs };
  }
}

const inProcessStore = new InProcessStore();

// ──────────────────────────────────────────────────────────────────────────────
// Core Execution Logic
// ──────────────────────────────────────────────────────────────────────────────
export async function executeRateLimitCheck(
  key: string,
  options: { windowMs: number; maxRequests: number; redis?: RedisClientOption }
): Promise<RateLimitCheckResult> {
  const { windowMs, maxRequests, redis } = options;

  let count: number;
  let remainingTtlMs: number;
  let usingFallback = false;

  const isAdapter = redis && 'evalFixedWindow' in redis;
  const isGeneric = redis && 'eval' in redis;
  const clientReady = isAdapter
    ? (redis as RedisRateLimitAdapter).isReady()
    : isGeneric
      ? ((redis as GenericRedisClientLike).isReady ?? (redis as GenericRedisClientLike).isOpen ?? true)
      : false;

  if (redis && clientReady) {
    try {
      if (isAdapter) {
        const [c, ttl] = await (redis as RedisRateLimitAdapter).evalFixedWindow(key, windowMs);
        count = c;
        remainingTtlMs = ttl > 0 ? ttl : windowMs;
      } else {
        const result = await (redis as GenericRedisClientLike).eval(FIXED_WINDOW_LUA, 1, key, windowMs);
        if (Array.isArray(result) && result.length >= 2) {
          count = Number(result[0]);
          remainingTtlMs = Number(result[1]) > 0 ? Number(result[1]) : windowMs;
        } else {
          count = Number(result);
          remainingTtlMs = windowMs;
        }
      }
    } catch {
      usingFallback = true;
      const fb = inProcessStore.increment(key, windowMs);
      count = fb.count;
      remainingTtlMs = fb.remainingTtlMs;
    }
  } else {
    usingFallback = true;
    const fb = inProcessStore.increment(key, windowMs);
    count = fb.count;
    remainingTtlMs = fb.remainingTtlMs;
  }

  const resetSeconds = Math.max(0, Math.ceil(remainingTtlMs / 1000));
  const remaining = Math.max(0, maxRequests - count);
  const isLimited = count > maxRequests;

  return {
    count,
    remaining,
    resetSeconds,
    remainingTtlMs,
    isLimited,
    usingFallback,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Express Middleware Factory
// ──────────────────────────────────────────────────────────────────────────────
export function createRateLimiter(options: RateLimiterOptions) {
  const {
    windowMs,
    maxRequests,
    message = 'Too many requests. Please slow down.',
    keyGenerator = (req: Request): string => req.ip ?? 'unknown',
    skip = () => false,
    redis,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (skip(req)) {
      next();
      return;
    }

    const key = `rl:${keyGenerator(req)}`;
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? 'unknown';

    const result = await executeRateLimitCheck(key, { windowMs, maxRequests, redis });

    // RFC 9333 RateLimit fields
    res.setHeader('RateLimit-Limit', maxRequests);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', result.resetSeconds);

    if (result.usingFallback) {
      res.setHeader('X-RateLimit-Fallback', 'in-process');
    }

    if (result.isLimited) {
      // RFC 6585 Retry-After field
      res.setHeader('Retry-After', result.resetSeconds);
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message,
          retryAfterSeconds: result.resetSeconds,
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId,
        },
      });
      return;
    }

    next();
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Preset Helpers
// ──────────────────────────────────────────────────────────────────────────────
export function createInquiryRateLimiter(redis?: RedisClientOption) {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5,
    message: 'You have submitted several inquiries recently. Please wait before sending another.',
    redis,
  });
}

export function createGeneralApiRateLimiter(redis?: RedisClientOption) {
  return createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 120,
    redis,
  });
}
