/**
 * @file auth-middleware.ts
 * @description Production-grade Authentication and RBAC Authorization Middleware.
 *
 * ── What changed from v1 & v2.0 ──────────────────────────────────────────────
 * • Explicitly requires the JWT exp (expiration) claim and validates it.
 * • Enforces a maximum token lifetime (MAX_TOKEN_LIFETIME_SECONDS = 24h).
 * • Enforces minimum secret strength for HS256: RFC 7518 Section 3.2 requires
 *   at least 256 bits (32 bytes). Shorter secrets reject with a clear error.
 * • Distinct handling of Redis revocation-store failures: Redis infrastructure
 *   errors return HTTP 503 REVOCATION_SERVICE_UNAVAILABLE rather than misreporting
 *   infrastructure downtime as invalid user credentials.
 * • Missing/invalid environment configuration returns HTTP 500 INTERNAL_CONFIGURATION_ERROR.
 * • Replaced hand-rolled verifier with the `jose` library (algorithms: ['HS256']).
 * • Authentication (authenticateJWT) and authorization (requireRoles) remain
 *   separate middleware functions.
 * • Tokens and secrets are never logged.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * NOTE — This is a recommended reference implementation.
 * It is NOT Cynbit's actual source code.
 */

import { Request, Response, NextFunction } from 'express';
import { jwtVerify, type JWTPayload } from 'jose';

// ──────────────────────────────────────────────────────────────────────────────
// Configuration & Cryptographic Constraints
// ──────────────────────────────────────────────────────────────────────────────

/** Minimum key length for HS256 (RFC 7518 Section 3.2: 256 bits / 32 bytes). */
export const MIN_SECRET_LENGTH_BYTES = 32;

/** Maximum acceptable token lifetime in seconds (24 hours). */
export const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/** Clock-skew tolerance in seconds for future-issued token validation (60 seconds). */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/** Accepted signing algorithms — explicit allow-list prevents alg confusion. */
export const ACCEPTED_ALGORITHMS = ['HS256'] as const;

export interface AuthConfig {
  secretKey: Uint8Array;
  issuer: string;
  audience: string;
  maxLifetimeSeconds: number;
  clockSkewToleranceSeconds: number;
}

/**
 * Validates and retrieves the JWT authentication configuration from environment.
 * Throws a descriptive error if any required setting is missing or inadequate.
 */
export function validateAuthConfig(): AuthConfig {
  const secretRaw = process.env.JWT_SECRET;
  if (!secretRaw || secretRaw.trim() === '') {
    throw new Error(
      '[auth-middleware] Required environment variable "JWT_SECRET" is not set. ' +
      'The service must not start or authenticate without a valid JWT secret.'
    );
  }

  const keyBytes = new TextEncoder().encode(secretRaw);
  if (keyBytes.length < MIN_SECRET_LENGTH_BYTES) {
    throw new Error(
      `[auth-middleware] JWT_SECRET is too short for HS256 (${keyBytes.length} bytes). ` +
      `RFC 7518 Section 3.2 requires a minimum key length of 256 bits (${MIN_SECRET_LENGTH_BYTES} bytes).`
    );
  }

  const issuer = process.env.JWT_ISSUER;
  if (!issuer || issuer.trim() === '') {
    throw new Error('[auth-middleware] Required environment variable "JWT_ISSUER" is not set.');
  }

  const audience = process.env.JWT_AUDIENCE;
  if (!audience || audience.trim() === '') {
    throw new Error('[auth-middleware] Required environment variable "JWT_AUDIENCE" is not set.');
  }

  return {
    secretKey: keyBytes,
    issuer,
    audience,
    maxLifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    clockSkewToleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
export type UserRole = 'ADMIN' | 'ENGINEER' | 'EDITOR' | 'CLIENT';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: UserRole[];
  sessionId: string;
}

/** JWT payload shape expected by this service. */
export interface CynbitJwtPayload extends JWTPayload {
  email: string;
  roles: UserRole[];
  /** Session ID — used for revocation. */
  sid: string;
}

// Extend Express Request so downstream handlers receive typed user context.
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Session Revocation Store
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal Redis interface compatible with ioredis and node-redis v4. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
}

export interface RevocationStore {
  isRevoked(sessionId: string): Promise<boolean>;
  revoke(sessionId: string): Promise<void>;
}

/**
 * In-process revocation fallback (single-node only).
 *
 * PROCESS-LOCAL IN-MEMORY REVOCATION LIMITATION:
 * The InProcessRevocationStore retains revoked session IDs in a heap-allocated Set.
 * In a multi-replica, clustered, or containerized deployment:
 * 1. A session revocation executed on Node A will NOT propagate to Node B.
 * 2. In-memory storage cannot provide globally consistent revocation across instances.
 * 3. Operators MUST inject a distributed Redis store using configureRevocationStore(redis)
 *    in horizontally scaled production environments.
 */
class InProcessRevocationStore implements RevocationStore {
  private readonly revoked = new Set<string>();
  async isRevoked(sessionId: string): Promise<boolean> {
    return this.revoked.has(sessionId);
  }
  async revoke(sessionId: string): Promise<void> {
    this.revoked.add(sessionId);
  }
}

let revocationStore: RevocationStore = new InProcessRevocationStore();

/**
 * Injects a Redis client for shared revocation across process replicas.
 * Call once during application bootstrap.
 */
export function configureRevocationStore(redis: RedisLike): void {
  revocationStore = {
    async isRevoked(sessionId: string): Promise<boolean> {
      const value = await redis.get(`cynbit:revoked:${sessionId}`);
      return value !== null;
    },
    async revoke(sessionId: string): Promise<void> {
      // TTL: 24 h — safety window matching max token lifetime
      await redis.set(`cynbit:revoked:${sessionId}`, '1', { EX: 86400 });
    },
  };
}

/** Explicitly override the revocation store (used in testing & custom stores). */
export function setRevocationStore(store: RevocationStore): void {
  revocationStore = store;
}

/** Reset to the default in-process revocation store. */
export function resetRevocationStore(): void {
  revocationStore = new InProcessRevocationStore();
}

/** Revoke a session. Accepts the session ID, not the token itself. */
export async function revokeSession(sessionId: string): Promise<void> {
  await revocationStore.revoke(sessionId);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function getRequestId(req: Request): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

function isValidRoleArray(value: unknown): value is UserRole[] {
  const valid: UserRole[] = ['ADMIN', 'ENGINEER', 'EDITOR', 'CLIENT'];
  return Array.isArray(value) && value.length > 0 && value.every((r) => valid.includes(r as UserRole));
}

// ──────────────────────────────────────────────────────────────────────────────
// Authentication Middleware
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the JWT Bearer token in the Authorization header.
 * On success, attaches a typed `req.user` object for downstream handlers.
 * Does NOT perform role-based access control — use requireRoles() for that.
 */
export async function authenticateJWT(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const requestId = getRequestId(req);

  // 1. Validate environment configuration
  let config: AuthConfig;
  try {
    config = validateAuthConfig();
  } catch (configErr: unknown) {
    const message = configErr instanceof Error ? configErr.message : 'Invalid auth configuration';
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_CONFIGURATION_ERROR',
        message: 'Authentication service configuration error.',
        detail: process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' ? message : undefined,
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    });
    return;
  }

  // 2. Extract Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authorization header is missing or is not in Bearer token format.',
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Bearer token string is empty.',
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    });
    return;
  }

  // 3. Cryptographic and semantic JWT verification
  let payload: CynbitJwtPayload;
  try {
    const verified = await jwtVerify<CynbitJwtPayload>(token, config.secretKey, {
      algorithms: [...ACCEPTED_ALGORITHMS],
      issuer: config.issuer,
      audience: config.audience,
    });
    payload = verified.payload;

    // Explicitly require exp claim
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new Error('Token is missing the "exp" (expiration) claim.');
    }

    // Explicitly require iat claim
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
      throw new Error('Token is missing the "iat" (issued at) claim.');
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // Reject tokens issued in the future beyond acceptable clock-skew tolerance
    if (payload.iat > nowSec + config.clockSkewToleranceSeconds) {
      throw new Error(
        `Token "iat" (${payload.iat}) is set in the future beyond acceptable clock-skew tolerance ` +
        `(${config.clockSkewToleranceSeconds}s). Token may have been issued with an invalid clock.`
      );
    }

    // Enforce maximum token lifetime
    const tokenLifetime = payload.exp - payload.iat;
    if (tokenLifetime <= 0) {
      throw new Error('Token expiration ("exp") must be strictly greater than issued time ("iat").');
    }

    if (tokenLifetime > config.maxLifetimeSeconds) {
      throw new Error(
        `Token lifetime (${tokenLifetime}s) exceeds maximum allowed lifetime (${config.maxLifetimeSeconds}s).`
      );
    }

    if (payload.exp > nowSec + config.maxLifetimeSeconds) {
      throw new Error(
        `Token expiration is further in the future than maximum allowed lifetime (${config.maxLifetimeSeconds}s).`
      );
    }

    // Validate required claims
    if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      throw new Error('Token is missing the "sub" (subject) claim.');
    }
    if (typeof payload.email !== 'string' || payload.email.trim() === '') {
      throw new Error('Token is missing the "email" claim.');
    }
    if (typeof payload.sid !== 'string' || payload.sid.trim() === '') {
      throw new Error('Token is missing the "sid" (session ID) claim.');
    }
    if (!isValidRoleArray(payload.roles)) {
      throw new Error('Token "roles" claim is absent or contains unrecognised roles.');
    }
  } catch (err: unknown) {
    const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : 'Token verification failed.';

    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Token verification failed. The token may be expired, malformed, or untrusted.',
        ...(isDev && { detail: errorName, reason: errorMessage }),
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    });
    return;
  }

  // 4. Check session revocation — infrastructure failures handled distinctly!
  let isRevoked = false;
  try {
    isRevoked = await revocationStore.isRevoked(payload.sid);
  } catch (revocationErr: unknown) {
    // Redis infrastructure failure (connection drop/timeout) — DO NOT report as invalid credentials!
    res.status(503).json({
      success: false,
      error: {
        code: 'REVOCATION_SERVICE_UNAVAILABLE',
        message: 'Authentication infrastructure failure: unable to verify session revocation status. Please try again shortly.',
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    });
    return;
  }

  if (isRevoked) {
    res.status(401).json({
      success: false,
      error: {
        code: 'SESSION_REVOKED',
        message: 'This session has been revoked. Please log in again.',
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    });
    return;
  }

  // 5. Attach authenticated user context
  req.user = {
    userId:    payload.sub,
    email:     payload.email,
    roles:     payload.roles,
    sessionId: payload.sid,
  };

  next();
}

// ──────────────────────────────────────────────────────────────────────────────
// Authorization Middleware (RBAC)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Enforces role-based access control.
 * Must be applied AFTER authenticateJWT on the same route.
 */
export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication is required before authorization can be checked.',
        },
        meta: { timestamp: new Date().toISOString(), requestId: getRequestId(req) },
      });
      return;
    }

    const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Access denied. Required role(s): ${allowedRoles.join(' | ')}.`,
        },
        meta: { timestamp: new Date().toISOString(), requestId: getRequestId(req) },
      });
      return;
    }

    next();
  };
}
