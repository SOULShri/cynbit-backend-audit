/**
 * @file error-handler.ts
 * @description Centralized Express error handling middleware.
 *
 * ── What changed from v1 ─────────────────────────────────────────────────────
 * • Fixed: crypto.randomUUID() was called without importing 'node:crypto'.
 *   The import is now explicit; `randomUUID` is destructured from 'node:crypto'.
 * • Stack traces are NEVER sent to clients in non-development environments.
 * • Database-level errors (Prisma P-codes) are caught and reduced to safe
 *   generic messages before reaching the response envelope.
 * • Correlation IDs are preserved from incoming x-request-id headers, or a
 *   new UUID is generated — consistently across every code path.
 * • Validation errors and known operational errors are handled separately from
 *   unexpected programmer errors, with distinct HTTP status codes.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * NOTE — This is a recommended reference implementation.
 * It is NOT Cynbit's actual source code.
 */

import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

// ──────────────────────────────────────────────────────────────────────────────
// Custom error hierarchy
// ──────────────────────────────────────────────────────────────────────────────

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  /**
   * Operational errors are known failure modes (validation, not found, etc.)
   * whose messages are safe to surface to the client.
   * Programmer errors (bugs, unexpected exceptions) are not operational;
   * their internal details must never reach the client.
   */
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_SERVER_ERROR',
    isOperational = true,
    details?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: unknown) {
    super(message, 404, 'NOT_FOUND', true, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', true, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details?: unknown) {
    super(message, 401, 'UNAUTHORIZED', true, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied', details?: unknown) {
    super(message, 403, 'FORBIDDEN', true, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details?: unknown) {
    super(message, 409, 'CONFLICT', true, details);
  }
}

export class RateLimitExceededError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', details?: unknown) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', true, details);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Returns true if the error originates from the Prisma client. */
function isPrismaError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('P')
  );
}

const isDev = process.env.NODE_ENV === 'development';

// ──────────────────────────────────────────────────────────────────────────────
// Centralized error middleware
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Must be registered LAST in the Express middleware chain.
 * Receives all errors forwarded via next(err).
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction   // Required 4-arg signature for Express to recognize this as an error handler
): void {
  // Preserve correlation ID from upstream headers, or generate a fresh one.
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  const timestamp = new Date().toISOString();

  let statusCode = 500;
  let code = 'INTERNAL_SERVER_ERROR';
  let clientMessage = 'An unexpected error occurred. Please try again or contact support.';
  let details: unknown = undefined;
  let isOperational = false;

  if (err instanceof AppError) {
    // Known operational error — safe to forward the message.
    statusCode = err.statusCode;
    code = err.code;
    clientMessage = err.message;
    details = err.details;
    isOperational = err.isOperational;
  } else if (isPrismaError(err)) {
    // Database-level error — never expose Prisma P-codes or query internals.
    statusCode = 500;
    code = 'DATABASE_ERROR';
    clientMessage = 'A database error occurred. Please try again later.';
    isOperational = false;
  }

  // ── Structured internal log (Pino / Winston compatible) ──────────────────
  const logEntry = {
    level: statusCode >= 500 ? 'error' : 'warn',
    timestamp,
    requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    errorCode: code,
    isOperational,
    // Log the actual error message internally, but never expose stack to client.
    internalMessage: err instanceof Error ? err.message : String(err),
    // Stack only in logs, never in response.
    stack: statusCode >= 500 && err instanceof Error ? err.stack : undefined,
  };

  if (process.env.NODE_ENV !== 'test') {
    if (statusCode >= 500) {
      console.error(JSON.stringify(logEntry));
    } else {
      console.warn(JSON.stringify(logEntry));
    }
  }

  // ── Client response ───────────────────────────────────────────────────────
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      // In production: suppress non-operational messages (programmer errors).
      message: isOperational || isDev ? clientMessage : 'An unexpected error occurred. Please contact support.',
      // Only include structured validation details if they are safe to expose.
      details: isOperational && details !== undefined ? details : undefined,
      // In development only: include stack for easier debugging.
      ...(isDev && !isOperational && err instanceof Error ? { stack: err.stack } : {}),
    },
    meta: {
      timestamp,
      requestId,
    },
  });
}
