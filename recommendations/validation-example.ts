/**
 * @file validation-example.ts
 * @description Zod-based request validation, sanitisation, and Express middleware.
 *
 * ── What changed from v1 ─────────────────────────────────────────────────────
 * • fullName regex now accepts Unicode letters (international names) instead
 *   of only ASCII a-zA-Z.  Used the \p{L} Unicode category via the 'u' flag.
 * • page / limit use z.coerce.number() with integer enforcement instead of
 *   relying on parseInt() fallback behaviour that silently accepts "3abc" → 3.
 * • Email is normalised to lowercase before validation (trim + toLowerCase).
 * • website_trap honeypot is correctly typed and validated.
 * • Clear separation of concerns documented:
 *     - VALIDATION: Zod checks structure and type invariants.
 *     - SANITISATION: .trim() / .toLowerCase() strip hazardous whitespace and
 *       normalise values.  Output encoding (e.g. HTML-escaping for display) is
 *       the responsibility of the rendering layer, NOT this module.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * NOTE — This is a recommended reference implementation.
 * It is NOT Cynbit's actual source code.
 */

import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// ──────────────────────────────────────────────────────────────────────────────
// Enumerations
// ──────────────────────────────────────────────────────────────────────────────
export const IndustryEnum = z.enum([
  'AI_AUTOMATION',
  'ENTERPRISE_SOFTWARE',
  'CLOUD_INFRASTRUCTURE',
  'EDTECH_TRAINING',
  'REAL_ESTATE_SAAS',
  'OTHER',
]);

export const InquiryStatusEnum = z.enum([
  'PENDING',
  'REVIEWED',
  'CONTACTED',
  'ARCHIVED',
]);

// ──────────────────────────────────────────────────────────────────────────────
// Create Inquiry Schema
// Models the observed fields on Cynbit's contact page:
//   fullName, email, company, industry, message
// ──────────────────────────────────────────────────────────────────────────────
export const CreateInquirySchema = z.object({
  fullName: z
    .string({ required_error: 'Full name is required.' })
    .trim()
    .min(2, 'Name must be at least 2 characters.')
    .max(100, 'Name must not exceed 100 characters.')
    /**
     * Accept Unicode letters, spaces, hyphens, apostrophes, and periods.
     * The 'u' flag enables \p{L} (any Unicode letter category) so that
     * names like "Aarav", "Müller", "O'Brien", "Nguyen-Thi" are all valid.
     * ASCII-only regex (/^[a-zA-Z\s.'-]+$/) incorrectly rejects these.
     */
    .regex(
      /^[\p{L}\s.'\-]+$/u,
      'Name may only contain letters, spaces, hyphens, apostrophes, or periods.'
    ),

  email: z
    .string({ required_error: 'Email address is required.' })
    .trim()
    .toLowerCase()   // SANITISATION: normalise before validation and storage
    .email('A valid email address is required.')
    .max(254, 'Email must not exceed 254 characters (RFC 5321).'),

  company: z
    .string()
    .trim()
    .max(120, 'Company name must not exceed 120 characters.')
    .optional()
    .default('Independent / Undisclosed'),

  industry: IndustryEnum.default('OTHER'),

  message: z
    .string({ required_error: 'Message is required.' })
    .trim()
    .min(10, 'Message must be at least 10 characters.')
    .max(3000, 'Message cannot exceed 3000 characters.'),

  /**
   * Anti-bot honeypot.
   * This field is not rendered as a visible input in the HTML form.
   * Automated form fillers populate all fields; a non-empty value indicates
   * a bot submission and the request is rejected immediately.
   *
   * IMPORTANT: This is one layer of defence, not the only one.
   * Combine with:
   *   - Server-side IP rate limiting (see rate-limiter.ts)
   *   - CAPTCHA for high-risk flows (e.g. Cloudflare Turnstile)
   *   - Content-based heuristics (spam word lists, reputation APIs)
   */
  website_trap: z
    .string()
    .max(0, 'Automated submission detected.')
    .optional(),
});

export type CreateInquiryDTO = z.infer<typeof CreateInquirySchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Query / Pagination Schema
// ──────────────────────────────────────────────────────────────────────────────
export const InquiryQuerySchema = z.object({
  /**
   * z.coerce.number() converts the raw query string to a number and then
   * applies .int() to reject values like "3.7" or "2abc".
   * This is stricter than parseInt() which silently accepts "3abc" → 3.
   */
  page: z
    .coerce
    .number({ invalid_type_error: 'page must be a whole number.' })
    .int('page must be a whole number.')
    .min(1, 'page must be at least 1.')
    .optional()
    .default(1),

  limit: z
    .coerce
    .number({ invalid_type_error: 'limit must be a whole number.' })
    .int('limit must be a whole number.')
    .min(1, 'limit must be at least 1.')
    .max(100, 'limit cannot exceed 100.')
    .optional()
    .default(20),

  industry: IndustryEnum.optional(),
  status: InquiryStatusEnum.optional(),

  search: z
    .string()
    .trim()
    .max(100, 'Search term cannot exceed 100 characters.')
    .optional(),

  sortBy: z
    .enum(['createdAt', 'fullName', 'company', 'status'])
    .optional()
    .default('createdAt'),

  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .default('desc'),
});

export type InquiryQueryDTO = z.infer<typeof InquiryQuerySchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Response DTO
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The shape returned to API consumers.
 *
 * IMPORTANT — Output encoding:
 * When rendering these values inside HTML templates, escape them using a
 * context-aware library (e.g. DOMPurify on the client, or a server-side
 * templating engine that auto-escapes).  Zod sanitisation (trim/lowercase)
 * is NOT a substitute for HTML output encoding.
 */
export interface InquiryResponseDTO {
  id: string;
  fullName: string;
  email: string;
  company: string;
  industry: z.infer<typeof IndustryEnum>;
  message: string;
  status: z.infer<typeof InquiryStatusEnum>;
  createdAt: Date;
  updatedAt: Date;
}

// ──────────────────────────────────────────────────────────────────────────────
// Express validation middleware factories
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validates and sanitises the request body against a Zod schema.
 * Replaces req.body with the parsed, type-safe value on success.
 * Returns HTTP 400 with structured field-level errors on failure.
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const result = await schema.safeParseAsync(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body failed validation.',
          details: result.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
            code: e.code,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: (req.headers['x-request-id'] as string | undefined) ?? 'unknown',
        },
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validates the request query string against a Zod schema.
 * Attaches the parsed value as req.validatedQuery.
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const result = await schema.safeParseAsync(req.query);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'QUERY_VALIDATION_ERROR',
          message: 'Query parameters failed validation.',
          details: result.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
            code: e.code,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: (req.headers['x-request-id'] as string | undefined) ?? 'unknown',
        },
      });
      return;
    }
    (req as Request & { validatedQuery: z.infer<T> }).validatedQuery = result.data;
    next();
  };
}
