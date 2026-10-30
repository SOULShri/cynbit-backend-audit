/**
 * @file api-example.ts
 * @description REST API Controller, Router, and trust-proxy guidance.
 *
 * ── What changed from v1 ─────────────────────────────────────────────────────
 * • Client IP extraction: req.ip is used (after Express trust proxy is
 *   configured) instead of blindly reading x-forwarded-for.  The trust proxy
 *   section below explains why this matters for rate-limit bypass prevention.
 * • The ApiResponse envelope and IInquiryService interface are preserved.
 * • The router factory correctly wires validateBody / validateQuery.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * ── Trust-proxy configuration (IMPORTANT) ────────────────────────────────────
 *
 * When your Node.js server sits behind a load-balancer or reverse proxy
 * (e.g. Nginx, Cloudflare, AWS ALB), the real client IP arrives in the
 * X-Forwarded-For header rather than the socket's remote address.
 *
 * Problem: if any value in X-Forwarded-For is trusted blindly, an attacker can
 * prepend a fake IP to the header and bypass IP-based rate limits:
 *   X-Forwarded-For: 1.2.3.4, real-client-ip, proxy-ip
 *
 * Solution: tell Express exactly how many trusted hops precede it.
 *   app.set('trust proxy', 1);   // 1 hop — e.g. a single load-balancer
 *   app.set('trust proxy', 2);   // 2 hops — e.g. CDN + load-balancer
 *
 * After this, Express reads the correct IP from X-Forwarded-For[-(n)] and
 * exposes it as req.ip.  Rate limiters that key on req.ip will then see the
 * genuine client IP, not a spoofed one.
 *
 * DO NOT set `trust proxy` to `true` globally in production — that trusts all
 * hops unconditionally, which allows full spoofing again.
 *
 * NOTE — This is a recommended reference implementation.
 * It is NOT Cynbit's actual source code.
 */

import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction, Router } from 'express';
import { z } from 'zod';
import {
  CreateInquirySchema,
  InquiryQuerySchema,
  InquiryResponseDTO,
  validateBody,
  validateQuery,
} from './validation-example';

// ──────────────────────────────────────────────────────────────────────────────
// Standard API response envelope
// ──────────────────────────────────────────────────────────────────────────────
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    timestamp: string;
    requestId: string;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Service layer interface (dependency inversion)
// ──────────────────────────────────────────────────────────────────────────────
export interface IInquiryService {
  createInquiry(
    dto: z.infer<typeof CreateInquirySchema>,
    clientIp: string
  ): Promise<InquiryResponseDTO>;

  getInquiries(query: z.infer<typeof InquiryQuerySchema>): Promise<{
    items: InquiryResponseDTO[];
    total: number;
    page: number;
    limit: number;
  }>;

  getInquiryById(id: string): Promise<InquiryResponseDTO | null>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function getRequestId(req: Request): string {
  return (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
}

/**
 * Resolves the client IP from req.ip (set by Express after trust proxy is
 * configured) rather than reading x-forwarded-for directly.
 *
 * If trust proxy is not set and req.ip is the loop-back / undefined, fall
 * back to socket address.  Log a warning in development so engineers notice.
 */
function resolveClientIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress;
  if (!ip || ip === '::1' || ip === '127.0.0.1') {
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        '[api-example] req.ip resolved to loopback. ' +
        'Ensure app.set("trust proxy", N) is configured for your proxy topology.'
      );
    }
  }
  return ip ?? 'unknown';
}

// ──────────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────────
export class InquiryController {
  constructor(private readonly inquiryService: IInquiryService) {}

  /**
   * POST /api/v1/inquiries
   * Public endpoint — requires rate limiting middleware upstream.
   */
  public create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto = req.body as z.infer<typeof CreateInquirySchema>;
      const clientIp = resolveClientIp(req);
      const created = await this.inquiryService.createInquiry(dto, clientIp);

      const response: ApiResponse<InquiryResponseDTO> = {
        success: true,
        data: created,
        meta: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/v1/inquiries
   * Protected — requires authentication + ADMIN or ENGINEER role.
   */
  public list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = (req as Request & { validatedQuery: z.infer<typeof InquiryQuerySchema> })
        .validatedQuery;
      const result = await this.inquiryService.getInquiries(query);
      const totalPages = Math.ceil(result.total / result.limit);

      const response: ApiResponse<InquiryResponseDTO[]> = {
        success: true,
        data: result.items,
        meta: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages,
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/v1/inquiries/:id
   * Protected — requires authentication.
   */
  public getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const inquiry = await this.inquiryService.getInquiryById(id);

      if (!inquiry) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Inquiry with ID "${id}" was not found.`,
          },
          meta: {
            timestamp: new Date().toISOString(),
            requestId: getRequestId(req),
          },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: inquiry,
        meta: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Router factory
// ──────────────────────────────────────────────────────────────────────────────
export function createInquiryRouter(
  controller: InquiryController,
  rateLimiterMiddleware: ReturnType<typeof import('./rate-limiter').createRateLimiter>,
  authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  requireRolesFn: (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => void
): Router {
  const router = Router();

  // Public — rate limited
  router.post(
    '/',
    rateLimiterMiddleware,
    validateBody(CreateInquirySchema),
    controller.create
  );

  // Protected — admin/engineering access
  router.get(
    '/',
    authMiddleware,
    requireRolesFn('ADMIN', 'ENGINEER'),
    validateQuery(InquiryQuerySchema),
    controller.list
  );

  router.get(
    '/:id',
    authMiddleware,
    requireRolesFn('ADMIN', 'ENGINEER'),
    controller.getById
  );

  return router;
}
