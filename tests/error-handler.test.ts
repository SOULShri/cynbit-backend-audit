/**
 * @file tests/error-handler.test.ts
 * Unit tests for error-handler.ts
 */

import {
  AppError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  errorHandler,
} from '../recommendations/error-handler';
import { Request, Response, NextFunction } from 'express';

// ── Minimal Express mock helpers ──────────────────────────────────────────────
function mockReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    method: 'GET',
    originalUrl: '/test',
    ip: '127.0.0.1',
  } as unknown as Request;
}

function mockRes() {
  const body: { statusCode: number; json: unknown } = { statusCode: 0, json: null };
  const res = {
    status(code: number) { body.statusCode = code; return res; },
    json(payload: unknown) { body.json = payload; return res; },
    _body: body,
  };
  return res as unknown as Response & { _body: typeof body };
}

const next: NextFunction = jest.fn();

// ──────────────────────────────────────────────────────────────────────────────
describe('errorHandler — AppError subclasses', () => {
  test('returns 404 for NotFoundError with safe message', () => {
    const err = new NotFoundError('Inquiry 123 not found');
    const req = mockReq({ 'x-request-id': 'req-1' });
    const res = mockRes();

    errorHandler(err, req, res as unknown as Response, next);

    expect(res._body.statusCode).toBe(404);
    const body = res._body.json as { success: boolean; error: { code: string; message: string }; meta: { requestId: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Inquiry 123 not found');
    expect(body.meta.requestId).toBe('req-1');
  });

  test('returns 400 for ValidationError', () => {
    const err = new ValidationError('Invalid email');
    const res = mockRes();
    errorHandler(err, mockReq(), res as unknown as Response, next);
    expect(res._body.statusCode).toBe(400);
    const body = res._body.json as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 403 for ForbiddenError', () => {
    const err = new ForbiddenError();
    const res = mockRes();
    errorHandler(err, mockReq(), res as unknown as Response, next);
    expect(res._body.statusCode).toBe(403);
    const body = res._body.json as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

describe('errorHandler — unknown / programmer errors', () => {
  const origEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = origEnv; });

  test('returns 500 for unexpected Error and hides message in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Internal DB connection string');
    const res = mockRes();
    errorHandler(err, mockReq(), res as unknown as Response, next);
    expect(res._body.statusCode).toBe(500);
    const body = res._body.json as { error: { message: string; stack?: string } };
    expect(body.error.message).not.toContain('DB connection string');
    expect(body.error.stack).toBeUndefined();
  });

  test('preserves correlation ID from x-request-id header', () => {
    const err = new AppError('Something', 500, 'ERR', false);
    const res = mockRes();
    errorHandler(err, mockReq({ 'x-request-id': 'test-correlation-456' }), res as unknown as Response, next);
    const body = res._body.json as { meta: { requestId: string } };
    expect(body.meta.requestId).toBe('test-correlation-456');
  });

  test('generates a correlation ID when x-request-id is absent', () => {
    const err = new Error('Some error');
    const res = mockRes();
    errorHandler(err, mockReq(), res as unknown as Response, next);
    const body = res._body.json as { meta: { requestId: string } };
    expect(typeof body.meta.requestId).toBe('string');
    expect(body.meta.requestId.length).toBeGreaterThan(0);
    expect(body.meta.requestId).not.toBe('unknown');
  });

  test('treats Prisma-like errors (P-code) as non-operational 500', () => {
    const prismaErr = Object.assign(new Error('PrismaClientKnownRequestError'), { code: 'P2002' });
    const res = mockRes();
    errorHandler(prismaErr, mockReq(), res as unknown as Response, next);
    expect(res._body.statusCode).toBe(500);
    const body = res._body.json as { error: { code: string; message: string } };
    expect(body.error.code).toBe('DATABASE_ERROR');
    expect(body.error.message).not.toContain('P2002');
  });
});
