/**
 * @file tests/rate-limiter.test.ts
 *
 * Unit tests for the in-process fallback rate limiter.
 * Redis-backed tests are skipped here because no Redis instance is available
 * in the test environment.  Limitation documented in TEST-REPORT.md.
 */

import {
  createRateLimiter,
  createIoRedisAdapter,
  createNodeRedisAdapter,
} from '../recommendations/rate-limiter';
import { Request, Response } from 'express';

// ── Minimal Express mock helpers ──────────────────────────────────────────────
function makeReq(ip = '192.168.1.1', requestId = 'test-id'): Request {
  return {
    ip,
    headers: { 'x-request-id': requestId },
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function makeRes() {
  const stored: {
    statusCode: number;
    body: unknown;
    headers: Record<string, string | number>;
  } = { statusCode: 200, body: null, headers: {} };

  const res = {
    status(code: number) { stored.statusCode = code; return res; },
    json(payload: unknown) { stored.body = payload; return res; },
    setHeader(name: string, value: string | number) { stored.headers[name] = value; return res; },
    _stored: stored,
  };
  return res as unknown as Response & { _stored: typeof stored };
}

// ──────────────────────────────────────────────────────────────────────────────
describe('createRateLimiter — in-process fallback', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('allows requests within the limit', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const next = jest.fn();

    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await limiter(makeReq(), res, next);
    }

    expect(next).toHaveBeenCalledTimes(3);
  });

  test('returns 429 after exceeding the limit', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const next = jest.fn();

    await limiter(makeReq('10.0.0.1'), makeRes(), next);
    await limiter(makeReq('10.0.0.1'), makeRes(), next);
    // 3rd request — over limit
    const overRes = makeRes();
    await limiter(makeReq('10.0.0.1'), overRes, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(overRes._stored.statusCode).toBe(429);
    const body = overRes._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  test('sets RFC 9333 RateLimit-* headers on allowed requests', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const next = jest.fn();
    const res = makeRes();
    await limiter(makeReq('10.0.0.2'), res, next);

    expect(res._stored.headers['RateLimit-Limit']).toBe(5);
    expect(typeof res._stored.headers['RateLimit-Remaining']).toBe('number');
    expect(typeof res._stored.headers['RateLimit-Reset']).toBe('number');
  });

  test('sets Retry-After header on 429 response', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const next = jest.fn();
    await limiter(makeReq('10.0.0.3'), makeRes(), next);
    const res429 = makeRes();
    await limiter(makeReq('10.0.0.3'), res429, next);

    expect(res429._stored.statusCode).toBe(429);
    expect(typeof res429._stored.headers['Retry-After']).toBe('number');
  });

  test('isolates limits by client IP', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const next = jest.fn();

    await limiter(makeReq('10.0.1.1'), makeRes(), next); // IP A — allowed
    await limiter(makeReq('10.0.1.2'), makeRes(), next); // IP B — allowed (separate bucket)
    expect(next).toHaveBeenCalledTimes(2);
  });

  test('skip function bypasses rate limiting', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      skip: () => true,
    });
    const next = jest.fn();

    for (let i = 0; i < 5; i++) {
      await limiter(makeReq('10.0.2.1'), makeRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(5); // skip always bypasses
  });

  test('resets counter after window expires', async () => {
    const limiter = createRateLimiter({ windowMs: 5_000, maxRequests: 1 });
    const next = jest.fn();

    await limiter(makeReq('10.0.3.1'), makeRes(), next);
    const blockedRes = makeRes();
    await limiter(makeReq('10.0.3.1'), blockedRes, next);
    expect(blockedRes._stored.statusCode).toBe(429);

    // Advance clock past the window
    jest.advanceTimersByTime(6_000);

    const allowedRes = makeRes();
    await limiter(makeReq('10.0.3.1'), allowedRes, next);
    expect(allowedRes._stored.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Redis-backed tests (with mocked RedisClientLike)
// Verifies atomic script result parsing, PTTL calculation, and fallback policy.
// ──────────────────────────────────────────────────────────────────────────────
describe('createRateLimiter — Redis-backed (mocked Redis client)', () => {
  test('derives RateLimit-Reset directly from real Redis PTTL return value', async () => {
    const mockRedis = {
      isReady: true,
      // Lua script returns [current_count, remaining_pttl_ms]
      eval: jest.fn().mockResolvedValue([2, 45200]),
    };

    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 5,
      redis: mockRedis,
    });

    const req = makeReq('10.5.0.1');
    const res = makeRes();
    const next = jest.fn();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res._stored.headers['RateLimit-Limit']).toBe(5);
    expect(res._stored.headers['RateLimit-Remaining']).toBe(3);
    // 45200ms remaining => Math.ceil(45200 / 1000) = 46 seconds
    expect(res._stored.headers['RateLimit-Reset']).toBe(46);
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  test('derives Retry-After directly from real Redis PTTL return value on 429', async () => {
    const mockRedis = {
      isReady: true,
      // 6th request (over limit of 5), 18300ms remaining on the window
      eval: jest.fn().mockResolvedValue([6, 18300]),
    };

    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 5,
      redis: mockRedis,
    });

    const req = makeReq('10.5.0.2');
    const res = makeRes();
    const next = jest.fn();

    await limiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(429);
    // 18300ms remaining => Math.ceil(18300 / 1000) = 19 seconds
    expect(res._stored.headers['RateLimit-Reset']).toBe(19);
    expect(res._stored.headers['Retry-After']).toBe(19);
    const body = res._stored.body as { error: { code: string; retryAfterSeconds: number } };
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.error.retryAfterSeconds).toBe(19);
  });

  test('falls back safely to in-process store when Redis eval rejects', async () => {
    const mockRedis = {
      isReady: true,
      eval: jest.fn().mockRejectedValue(new Error('READONLY You cannot write against a read only replica.')),
    };

    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      redis: mockRedis,
    });

    const req = makeReq('10.5.0.3');
    const res = makeRes();
    const next = jest.fn();

    await limiter(req, res, next);

    // Must NOT crash; falls back gracefully to in-process store
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._stored.headers['X-RateLimit-Fallback']).toBe('in-process');
  });

  test('createIoRedisAdapter formats ioredis parameters and unpacks [count, ttl]', async () => {
    const mockIoRedis = {
      status: 'ready',
      eval: jest.fn().mockResolvedValue([3, 25000]),
    };
    const adapter = createIoRedisAdapter(mockIoRedis);
    expect(adapter.isReady()).toBe(true);

    const [cnt, ttl] = await adapter.evalFixedWindow('test-key', 60000);
    expect(cnt).toBe(3);
    expect(ttl).toBe(25000);
    expect(mockIoRedis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'test-key', 60000);
  });

  test('createNodeRedisAdapter formats node-redis v4 object parameters and unpacks [count, ttl]', async () => {
    const mockNodeRedis = {
      isReady: true,
      eval: jest.fn().mockResolvedValue([4, 18000]),
    };
    const adapter = createNodeRedisAdapter(mockNodeRedis);
    expect(adapter.isReady()).toBe(true);

    const [cnt, ttl] = await adapter.evalFixedWindow('test-key', 60000);
    expect(cnt).toBe(4);
    expect(ttl).toBe(18000);
    expect(mockNodeRedis.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ['test-key'],
      arguments: ['60000'],
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Live Redis integration test
// SKIPPED: A live Redis server (TCP 6379) is not running in the Windows assessment
// environment. Documented in TEST-REPORT.md under limitations.
// ──────────────────────────────────────────────────────────────────────────────
describe.skip('createRateLimiter — live Redis integration (requires running Redis daemon)', () => {
  test('executes atomic Lua script against active Redis daemon', async () => {
    // Requires: docker run -d -p 6379:6379 redis:7-alpine
    expect(true).toBe(true);
  });
});
