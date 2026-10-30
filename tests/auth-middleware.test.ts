/**
 * @file tests/auth-middleware.test.ts
 * @description Comprehensive unit tests for JWT authentication & RBAC middleware.
 *
 * Covers:
 *  1. Valid JWT
 *  2. Expired JWT
 *  3. Missing exp claim
 *  4. Invalid signature
 *  5. Invalid issuer and audience
 *  6. Invalid role & requireRoles authorization
 *  7. Revoked session
 *  8. Missing / weak environment configuration
 *  9. Redis revocation-store failure (handled distinctly as 503)
 */

import { Request, Response } from 'express';
import { SignJWT } from 'jose';
import {
  authenticateJWT,
  requireRoles,
  revokeSession,
  setRevocationStore,
  resetRevocationStore,
} from '../recommendations/auth-middleware';

const VALID_SECRET = 'cynbit_test_jwt_secret_must_be_at_least_32_bytes_long_ok!';
const VALID_ISSUER = 'https://portal.cynbit.in/auth';
const VALID_AUDIENCE = 'https://api.cynbit.in';
const SECRET_KEY = new TextEncoder().encode(VALID_SECRET);

function makeReq(token?: string, requestId = 'req-test-123'): Request {
  return {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-request-id': requestId,
    },
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

interface TokenOptions {
  sub?: string;
  email?: string;
  roles?: string[];
  sid?: string;
  omitExp?: boolean;
  expOffsetSec?: number;
  iatOffsetSec?: number;
  issuer?: string;
  audience?: string;
  signingSecret?: Uint8Array;
}

async function signTestToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    email: options.email ?? 'engineer@cynbit.in',
    roles: options.roles ?? ['ENGINEER'],
    sid: options.sid ?? 'session-valid-abc',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.sub ?? 'user-123')
    .setIssuer(options.issuer ?? VALID_ISSUER)
    .setAudience(options.audience ?? VALID_AUDIENCE);

  if (options.iatOffsetSec !== undefined) {
    jwt.setIssuedAt(now + options.iatOffsetSec);
  } else {
    jwt.setIssuedAt(now);
  }

  if (!options.omitExp) {
    const expOffset = options.expOffsetSec !== undefined ? options.expOffsetSec : 900; // 15 mins default
    jwt.setExpirationTime(now + expOffset);
  }

  return jwt.sign(options.signingSecret ?? SECRET_KEY);
}

describe('authenticateJWT Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: VALID_SECRET,
      JWT_ISSUER: VALID_ISSUER,
      JWT_AUDIENCE: VALID_AUDIENCE,
      NODE_ENV: 'test',
    };
    resetRevocationStore();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRevocationStore();
  });

  // 1. Valid JWT
  test('authenticates valid JWT and populates req.user', async () => {
    const token = await signTestToken({
      sub: 'eng-456',
      email: 'alex@cynbit.in',
      roles: ['ENGINEER', 'ADMIN'],
      sid: 'sess-xyz',
    });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual({
      userId: 'eng-456',
      email: 'alex@cynbit.in',
      roles: ['ENGINEER', 'ADMIN'],
      sessionId: 'sess-xyz',
    });
  });

  // 2. Expired JWT
  test('rejects expired JWT with 401 INVALID_TOKEN', async () => {
    const token = await signTestToken({
      expOffsetSec: -60, // expired 1 minute ago
      iatOffsetSec: -300,
    });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  // 3. Missing exp claim
  test('rejects JWT missing the exp claim with 401 INVALID_TOKEN', async () => {
    const token = await signTestToken({ omitExp: true });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  // 3b. Future-issued iat with clock-skew tolerance
  test('rejects JWT with future-issued iat exceeding clock-skew tolerance (60s)', async () => {
    const token = await signTestToken({
      iatOffsetSec: 120, // 2 minutes in future (> 60s tolerance)
      expOffsetSec: 1200,
    });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('accepts JWT with slightly future iat within clock-skew tolerance (15s)', async () => {
    const token = await signTestToken({
      iatOffsetSec: 15, // 15s in future (<= 60s tolerance)
      expOffsetSec: 900,
    });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeDefined();
  });

  // 4. Invalid signature
  test('rejects JWT signed with an untrusted key with 401 INVALID_TOKEN', async () => {
    const otherSecret = new TextEncoder().encode('different_secret_key_at_least_32_characters_long_abc!');
    const token = await signTestToken({ signingSecret: otherSecret });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  // 5. Invalid issuer and audience
  test('rejects JWT with untrusted issuer with 401 INVALID_TOKEN', async () => {
    const token = await signTestToken({ issuer: 'https://evil.attacker.com' });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('rejects JWT with wrong audience with 401 INVALID_TOKEN', async () => {
    const token = await signTestToken({ audience: 'https://other-service.cynbit.in' });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  // 6. Invalid role and authorization
  test('rejects JWT with unrecognised roles with 401 INVALID_TOKEN', async () => {
    const token = await signTestToken({ roles: ['SUPER_ROOT_UNRECOGNIZED'] });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  test('requireRoles blocks unauthorized roles with 403 FORBIDDEN', async () => {
    const token = await signTestToken({ roles: ['CLIENT'] });
    const req = makeReq(token);
    const res = makeRes();
    const nextAuth = jest.fn();

    await authenticateJWT(req, res, nextAuth);
    expect(nextAuth).toHaveBeenCalled();

    const guard = requireRoles('ADMIN', 'ENGINEER');
    const resForbidden = makeRes();
    const nextGuard = jest.fn();

    guard(req, resForbidden, nextGuard);

    expect(nextGuard).not.toHaveBeenCalled();
    expect(resForbidden._stored.statusCode).toBe(403);
    const body = resForbidden._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // 7. Revoked session
  test('rejects revoked session with 401 SESSION_REVOKED', async () => {
    const sid = 'session-to-revoke-999';
    const token = await signTestToken({ sid });

    // Revoke the session
    await revokeSession(sid);

    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(401);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_REVOKED');
  });

  // 8. Missing / weak environment configuration
  test('returns 500 when JWT_SECRET is missing from environment', async () => {
    delete process.env.JWT_SECRET;
    const token = await signTestToken();
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(500);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_CONFIGURATION_ERROR');
  });

  test('returns 500 when JWT_SECRET is weaker than 32 bytes (RFC 7518 HS256 rule)', async () => {
    process.env.JWT_SECRET = 'short_weak_key'; // < 32 bytes
    const token = await signTestToken();
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(500);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_CONFIGURATION_ERROR');
  });

  // 9. Redis revocation-store failure
  test('handles Redis revocation infrastructure failure distinctly with 503 (not 401)', async () => {
    // Inject a failing Redis store that throws an infrastructure exception
    setRevocationStore({
      async isRevoked() {
        throw new Error('ECONNREFUSED: Redis instance at 10.0.0.5:6379 is unreachable');
      },
      async revoke() {
        throw new Error('ECONNREFUSED');
      },
    });

    const token = await signTestToken();
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    // Critical: Must NOT return 401 INVALID_TOKEN or call next()
    expect(next).not.toHaveBeenCalled();
    expect(res._stored.statusCode).toBe(503);
    const body = res._stored.body as { error: { code: string } };
    expect(body.error.code).toBe('REVOCATION_SERVICE_UNAVAILABLE');
  });
});
