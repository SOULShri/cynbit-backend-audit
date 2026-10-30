# Backend Architecture Reference Implementations

This directory contains standalone, production-grade TypeScript reference implementations designed to address the findings identified during the technical audit of `cynbit.in`.

---

## 1. Module Overview

| File | Subsystem | Key Technical Responsibilities |
|:---|:---|:---|
| [`rate-limiter.ts`](./rate-limiter.ts) | Traffic Throttling | Redis-backed fixed-window counter using atomic Lua script (`INCR` + `PEXPIRE` + `PTTL`), dedicated `ioredis`/`node-redis` adapters, process-local in-memory fallback, and RFC 9333 headers. |
| [`auth-middleware.ts`](./auth-middleware.ts) | Security & Access | Timing-safe JWT verification via `jose`, HS256 algorithm allow-list, 256-bit key strength validation (RFC 7518), 60s clock-skew tolerance, 24h max lifetime, and distinct 503 Redis infrastructure error handling. |
| [`api-example.ts`](./api-example.ts) | HTTP Transport | Express Router configuration, trust-proxy resolution (`app.set('trust proxy', 1)`), correlation ID injection (`x-request-id`), and controller envelope patterns. |
| [`validation-example.ts`](./validation-example.ts) | Input Sanitization | Runtime Zod schema validation (`safeParseAsync`), Unicode international name validation (`\p{L}`), anti-bot honeypot trapping, and integer pagination coercion. |
| [`error-handler.ts`](./error-handler.ts) | Resilience & Masking | Centralized Express error handler, operational `AppError` hierarchy, Prisma database error masking (`P-code` interception), and production stack trace suppression. |
| [`database-example.ts`](./database-example.ts) | Persistence & Caching | Repository pattern isolating Prisma ORM queries, read-through Redis caching, and cache invalidation on mutation. |

---

## 2. Distributed Architecture Considerations

### Process-Local Fallbacks vs. Clustered Deployments
- Both `rate-limiter.ts` and `auth-middleware.ts` contain in-memory fallback stores to maintain service availability if Redis experiences an outage.
- **Process-Local Constraint:** In-memory stores maintain state strictly within the local Node.js process heap. They do not synchronize state across multiple horizontal server replicas or serverless worker instances.
- **Production Guidance:** In horizontally scaled environments, operators must configure shared Redis client instances using `createIoRedisAdapter()` or `createNodeRedisAdapter()`.
