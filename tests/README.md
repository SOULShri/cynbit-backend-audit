# Test Suite & Verification Matrix

This directory contains automated unit and mock integration tests covering the TypeScript reference implementations.

---

## 1. Test Execution Commands

```powershell
# Run full test suite
npm test

# Run tests with coverage reporting
npm run test:coverage

# Run TypeScript compilation check
npm run build
```

---

## 2. Test File Breakdown

| Test File | Target Module | Scope & Scenarios Covered |
|:---|:---|:---|
| [`auth-middleware.test.ts`](./auth-middleware.test.ts) | `auth-middleware.ts` | Valid JWT authentication, expired tokens, missing `exp`, future `iat` with clock-skew tolerance, invalid signatures, invalid issuer/audience, role authorization (`requireRoles`), revoked sessions, weak secret rejection (<32 bytes), and distinct 503 handling on Redis infrastructure failure. |
| [`rate-limiter.test.ts`](./rate-limiter.test.ts) | `rate-limiter.ts` | Threshold enforcement, HTTP 429 status, RFC 9333 headers, `Retry-After` derivation from Redis `PTTL`, IP isolation, `skip()` bypass, in-process fallback on Redis errors, and dedicated adapter tests (`ioredis`, `node-redis`). |
| [`validation.test.ts`](./validation.test.ts) | `validation-example.ts` | Schema parsing, Unicode international name handling, length boundaries, email format normalization, honeypot bot interception, and coerced integer pagination. |
| [`error-handler.test.ts`](./error-handler.test.ts) | `error-handler.ts` | Operational error mapping (400, 403, 404), Prisma P-code interception, correlation ID preservation, and stack trace hiding in production. |
| [`database.test.ts`](./database.test.ts) | `database-example.ts` | Repository query delegation, read-through Redis cache hits/misses, fallback on Redis exceptions, and cache invalidation on status updates. |

---

## 3. Test Categories & Environment Boundaries

- **Unit Tests:** Pure functional logic tested in isolation using Jest (e.g. Zod validation rules, token creation/verification via `jose`).
- **Mocked Dependency Tests:** Redis command evaluations and Prisma client interactions are verified via mocked client interfaces to guarantee deterministic behavior.
- **Live Integration Tests:** One live Redis integration test in `rate-limiter.test.ts` is explicitly marked `describe.skip` because a live Redis daemon (port 6379) is not running in the local evaluation environment.
- **Assessment Safety Boundary:** No network requests or test form submissions were sent to `cynbit.in` during testing.
