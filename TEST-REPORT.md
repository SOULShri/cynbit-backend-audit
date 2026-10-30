# TEST-REPORT.md — Cynbit Backend Audit

**Date:** October 30, 2026  
**Environment:** Windows 11, Node.js v22.13.1, TypeScript 5.9.3, Jest 29.7.0

---

## 1. Commands Executed

```powershell
# 1. TypeScript compilation (zero-error check)
npm run build

# 2. Automated test suite execution
npm test
```

---

## 2. TypeScript Strict Compilation

**Command:** `npm run build` (`npx tsc --noEmit`)  
**Exit Code:** `0`  
**Output:** Clean compilation with 0 errors and 0 warnings under strict TypeScript settings.

---

## 3. Test Results Summary

**Command:** `npm test` (`node node_modules/jest/bin/jest.js --runInBand`)  
**Exit Code:** `0`

```text
PASS tests/auth-middleware.test.ts
PASS tests/rate-limiter.test.ts
PASS tests/validation.test.ts
PASS tests/error-handler.test.ts
PASS tests/database.test.ts

Test Suites: 5 passed, 5 total
Tests:       1 skipped, 57 passed, 58 total
Snapshots:   0 total
Time:        3.478 s
Ran all test suites.
```

---

## 4. Test Coverage Matrix

| Test Suite | Module Under Test | Tests Passed | Tests Skipped | Status |
|:---|:---|:---:|:---:|:---:|
| `tests/auth-middleware.test.ts` | `recommendations/auth-middleware.ts` | 14 | 0 | **PASS** |
| `tests/rate-limiter.test.ts` | `recommendations/rate-limiter.ts` | 12 | 1 | **PASS** |
| `tests/validation.test.ts` | `recommendations/validation-example.ts` | 14 | 0 | **PASS** |
| `tests/error-handler.test.ts` | `recommendations/error-handler.ts` | 8 | 0 | **PASS** |
| `tests/database.test.ts` | `recommendations/database-example.ts` | 9 | 0 | **PASS** |
| **TOTAL** | | **57** | **1** | **ALL PASSED** |

---

## 5. Detailed Test Breakdown

### 5.1 `auth-middleware.test.ts` (14 tests)
- **Valid JWT:** Authenticates valid HS256 token and correctly attaches typed `req.user` context (`userId`, `email`, `roles`, `sessionId`).
- **Expired JWT:** Rejects tokens where `exp` is in the past with HTTP 401 `INVALID_TOKEN`.
- **Missing `exp` Claim:** Rejects tokens without an explicit `exp` claim with HTTP 401 `INVALID_TOKEN`.
- **Future-Issued `iat` Check:** Rejects tokens whose issued time exceeds the 60-second clock-skew tolerance (`CLOCK_SKEW_TOLERANCE_SECONDS`).
- **Clock-Skew Acceptance:** Accepts tokens issued slightly in the future within the 60-second tolerance window (e.g. 15s time drift).
- **Invalid Signature:** Rejects tokens signed with untrusted keys with HTTP 401 `INVALID_TOKEN`.
- **Invalid Issuer:** Rejects tokens where `iss` does not match `JWT_ISSUER` with HTTP 401 `INVALID_TOKEN`.
- **Invalid Audience:** Rejects tokens where `aud` does not match `JWT_AUDIENCE` with HTTP 401 `INVALID_TOKEN`.
- **Invalid Role:** Rejects tokens containing unrecognised or empty roles with HTTP 401 `INVALID_TOKEN`.
- **Role-Based Authorization (`requireRoles`):** Blocks authenticated users lacking required role with HTTP 403 `FORBIDDEN`.
- **Revoked Session:** Rejects tokens whose `sid` has been revoked via `revokeSession()` with HTTP 401 `SESSION_REVOKED`.
- **Missing Configuration:** Returns HTTP 500 `INTERNAL_CONFIGURATION_ERROR` when `JWT_SECRET` is unset.
- **Weak Secret Enforcement:** Returns HTTP 500 `INTERNAL_CONFIGURATION_ERROR` when `JWT_SECRET` is shorter than 32 bytes (256 bits) per RFC 7518 Section 3.2.
- **Redis Revocation-Store Infrastructure Failure:** Distinctly returns HTTP 503 `REVOCATION_SERVICE_UNAVAILABLE` when the Redis revocation store encounters network or timeout failures, preventing infrastructure downtime from being misreported as invalid user credentials.

### 5.2 `rate-limiter.test.ts` (12 passed, 1 skipped)
- **Within Limit:** Allows requests within the configured threshold.
- **Rate Exceeded:** Returns HTTP 429 `RATE_LIMIT_EXCEEDED` once limit is passed.
- **RFC 9333 Headers:** Sets `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers.
- **RFC 6585 Headers:** Sets `Retry-After` on 429 response.
- **IP Isolation:** Isolates rate-limit counters strictly by resolved client IP.
- **Bypass Rule:** Confirms `skip()` callback allows requests to bypass limits.
- **Window Expiry:** Confirms counter resets after window duration elapses.
- **Redis PTTL Derivation:** Verifies Lua script return parsing and confirms `RateLimit-Reset` is calculated directly from Redis `PTTL`.
- **Redis Retry-After Derivation:** Verifies `Retry-After` on 429 is calculated directly from Redis `PTTL`.
- **Redis Error Fallback:** Confirms middleware gracefully falls back to the in-process counter with `X-RateLimit-Fallback: in-process` when Redis commands reject.
- **`ioredis` Adapter Support:** Verifies `createIoRedisAdapter` correctly passes parameters to `ioredis` client and unpacks `[count, ttl]`.
- **`node-redis` Adapter Support:** Verifies `createNodeRedisAdapter` formats arguments as expected by node-redis v4 and unpacks `[count, ttl]`.
- **SKIPPED (Live Redis):** Live Redis daemon execution skipped (see section 6).

### 5.3 `validation.test.ts` (14 tests)
- Accepts standard English names.
- Accepts Unicode / international names (e.g. Müller, García, O'Brien) via Unicode property escapes (`\p{L}`).
- Rejects names with numeric or forbidden symbol characters.
- Rejects names shorter than 2 characters.
- Rejects invalid email formats and normalizes valid emails to lowercase.
- Rejects messages shorter than 10 or longer than 3,000 characters.
- Anti-bot detection: Rejects submissions with populated honeypot field (`website_trap`).
- Accepts submissions with empty honeypot field.
- Defaults unspecified industry to `OTHER`.
- Accepts valid integer pagination parameters (`page`, `limit`).
- Rejects non-integer (`"3.5"`) and alphanumeric (`"2abc"`) pagination parameters via strict coercion.
- Rejects limits exceeding 100.
- Defaults pagination to `page: 1, limit: 20`.

### 5.4 `error-handler.test.ts` (8 tests)
- Returns HTTP 404 for `NotFoundError` with client-safe message.
- Returns HTTP 400 for `ValidationError`.
- Returns HTTP 403 for `ForbiddenError`.
- Masks internal error details in production environments.
- Protects stack traces from leaking to clients in production.
- Preserves incoming `x-request-id` header in response envelopes.
- Generates a fresh UUIDv4 correlation ID when `x-request-id` is absent.
- Detects Prisma P-code errors and masks them as generic `DATABASE_ERROR` responses.

### 5.5 `database.test.ts` (9 tests)
- `create()` persists inquiry with `PENDING` status and resolved `clientIp`.
- `findById()` serves cached data directly without database query on cache hit.
- `findById()` fetches from PostgreSQL and populates Redis on cache miss.
- `findById()` falls back gracefully to database when Redis query throws.
- `updateStatus()` invalidates Redis cache entry (`DEL`) upon successful database update.
- `updateStatus()` completes transaction without throwing if cache invalidation fails.
- `createIoRedisCacheAdapter` translates `.set()` into `ioredis` `.setex(key, ttl, value)`.
- `createNodeRedisCacheAdapter` translates `.set()` into `node-redis` `.setEx(key, ttl, value)`.
- `createNodeRedisCacheAdapter` supports `node-redis` v4 `.set(key, value, { EX: ttl })`.

---

## 6. Documented Limitations & Skipped Tests

### 6.1 Live Redis Daemon Integration (1 test skipped)
- **Reason:** A live Redis daemon (port 6379) is not running in the current local assessment environment.
- **Verification Strategy:** The Redis integration was thoroughly verified using mock Redis clients testing the exact Lua script execution path, `PTTL` duration parsing, client adapters (`ioredis` and `node-redis`), and fallback behaviour.
- **Instructions to Run Live:**
  ```powershell
  docker run -d -p 6379:6379 redis:7-alpine
  $env:REDIS_URL = "redis://127.0.0.1:6379"
  npm test
  ```

### 6.2 Assessment Safety Boundaries
- In strict adherence to ethical assessment guidelines, no live penetration testing, active vulnerability exploitation, or unsolicited form submissions were dispatched to `cynbit.in`.
