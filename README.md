# Cynbit Backend Technical Audit

An independent technical audit of the public web infrastructure of Cynbit Technologies ([https://www.cynbit.in/](https://www.cynbit.in/)) conducted for a Backend Developer assessment. The evaluation reviews edge deployment patterns, Server Action RPC integration, security header posture, caching efficiency, and presents reference TypeScript implementations for a decoupled backend architecture.

---

## Reviewer Quick-Start Guide

If you have 2–5 minutes to evaluate this audit, start here:

| Area of Interest | Recommended Starting Point | Key Content / Takeaway |
|:---|:---|:---|
| **Executive Summary** | [`docs/01-audit-overview.md`](./docs/01-audit-overview.md) | High-level findings, assessment protocol, and evidence boundaries. |
| **Observed Architecture** | [`docs/02-architecture-analysis.md`](./docs/02-architecture-analysis.md) | Next.js Server Action RPC analysis and Vercel edge deployment mechanics. |
| **Visual Diagrams** | [`diagrams/README.md`](./diagrams/README.md) | GitHub-rendered diagrams + [Interactive Visualizer](./diagrams/index.html) (pan, zoom, tabs). |
| **Security Review** | [`docs/04-security-findings.md`](./docs/04-security-findings.md) | Transport security analysis and 7 concrete header hardening recommendations. |
| **Performance Profile** | [`docs/05-performance-findings.md`](./docs/05-performance-findings.md) | Edge cache hit latencies (49ms–131ms) vs. dynamic SSR compute latencies (780ms–1576ms). |
| **Target Architecture** | [`docs/06-recommendations.md`](./docs/06-recommendations.md) | Decoupled Node.js backend blueprint with Controller-Service-Repository pattern. |
| **Code Implementations** | [`recommendations/`](./recommendations/) | TypeScript modules: atomic Redis Lua limiter, JWT verification with clock skew, Zod schemas. |
| **Test Evidence** | [`TEST-REPORT.md`](./TEST-REPORT.md) | Verified test suite execution output (57 passed tests across 5 test suites). |

---

## Assessment Objective

The goal of this audit is to evaluate `cynbit.in` from a backend engineering perspective using non-intrusive, passive inspection. It analyzes how the frontend communicates with server-side components, identifies edge security hardening gaps, benchmarks response latencies, and proposes structured backend architectures suitable for scaling high-throughput workloads.

---

## Scope and Methodology

- **Target:** `https://www.cynbit.in/` (Apex marketing domain and public routes).
- **Inspection Protocol:** 100% passive HTTP header inspection, TLS handshake analysis, and client-side JavaScript bundle reverse-engineering.
- **Safety Boundaries:**
  - Zero vulnerability exploitation or fuzzing.
  - Zero test submissions to the contact form Server Action (`submitInquiry`); form submission was deliberately uninvoked.
  - Zero automated vulnerability scanning or denial-of-service traffic.
  - Subdomains (`portal.cynbit.in`) were not probed beyond confirming the HTTP 307 redirect boundary.

---

## Repository Structure

```text
cynbit-backend-audit/
├── README.md                           # Project overview, reviewer guide, and instructions
├── LICENSE                             # MIT License
├── .gitignore                          # Standard Node.js / TypeScript exclusions
├── package.json                        # Scripts and dependencies (TypeScript, Jest, jose, zod)
├── tsconfig.json                       # Strict TypeScript configuration
├── TEST-REPORT.md                      # Verified test execution results and coverage matrix
├── docs/                               # Systematic audit documentation
│   ├── 01-audit-overview.md            # Executive summary, methodology, and evidence boundaries
│   ├── 02-architecture-analysis.md     # Observed edge topology and Next.js Server Action RPC
│   ├── 03-api-inventory.md             # Public route and network telemetry inventory
│   ├── 04-security-findings.md         # Transport analysis and security header gaps
│   ├── 05-performance-findings.md      # Edge caching efficiency and latency profiling
│   └── 06-recommendations.md           # Proposed decoupled backend architecture
├── recommendations/                    # TypeScript reference implementations
│   ├── README.md                       # Module descriptions and architectural context
│   ├── auth-middleware.ts              # Cryptographic JWT signature verification, RBAC, and clock-skew tolerance
│   ├── rate-limiter.ts                 # Atomic Redis Lua fixed-window limiter & RFC 9333 headers
│   ├── api-example.ts                  # Express router, proxy trust, and correlation IDs
│   ├── validation-example.ts           # Zod schema validation with Unicode & honeypot support
│   ├── error-handler.ts                # Centralized error handler and database error masking
│   └── database-example.ts             # Prisma ORM repository pattern and Redis cache adapters
├── tests/                              # Automated test suites
│   ├── README.md                       # Test matrix, boundaries, and execution guide
│   ├── auth-middleware.test.ts         # 14 tests covering JWT verification, clock skew, and RBAC
│   ├── rate-limiter.test.ts            # 12 tests covering thresholds, PTTL, and adapters
│   ├── validation.test.ts              # 14 tests covering Zod schemas and bot honeypot
│   ├── error-handler.test.ts           # 8 tests covering error translation and masking
│   └── database.test.ts                # 9 tests covering repository queries, caching, and Redis adapters
└── diagrams/                           # Visual architecture models & interactive viewer
    ├── README.md                       # Visual diagram showcase with native GitHub Mermaid rendering
    ├── index.html                      # Standalone interactive visualizer (pan, zoom, tabs, theme toggle)
    ├── observed-request-flow.mmd       # Observed Next.js Server Action sequence flow
    ├── recommended-architecture.mmd    # Multi-tier system architecture diagram
    └── security-request-flow.mmd       # End-to-end security and validation sequence flow
```

---

## Key Findings Summary

### Observed Infrastructure
- **Framework & Runtime:** Next.js App Router (React Server Components) hosted on the Vercel Edge Network, terminating at the Mumbai POP (`bom1`).
- **Endpoint Surface:** No generic RESTful or GraphQL endpoints under `/api`. Form submissions use internal React Server Action RPC (`submitInquiry`, ID: `40247ba4...` identified in client JavaScript bundle; form submission was uninvoked).
- **Administrative Boundary:** `/portal` redirects externally via HTTP 307 to `https://portal.cynbit.in/`, confirming separation of marketing assets from application portals.

### Security Posture
- **Transport:** High grade (TLS 1.3, AES-128-GCM cipher suite, valid Let's Encrypt certificate, 2-year HSTS).
- **Hardening Gaps:**
  - `Access-Control-Allow-Origin: *` returned globally (hardening gap; benign on static content, but risk if inherited by private routes).
  - Missing Content Security Policy (`Content-Security-Policy`).
  - Missing clickjacking mitigation (`X-Frame-Options` / `frame-ancestors`).
  - Missing MIME sniffing protection (`X-Content-Type-Options: nosniff`).
  - Missing explicit `Referrer-Policy` and `Permissions-Policy`.
  - Contact form contains no observable client-side CAPTCHA; abuse prevention relies on backend controls.

### Performance Profile
- **Edge Hit Latencies:** Pre-rendered Incremental Static Regeneration (ISR) marketing pages respond in **49ms – 131ms**.
- **Origin Compute Latencies:** Server-Side Rendered (SSR) routes (`/careers`, `/blog`, `/sitemap.xml`) show origin render times between **780ms and 1,576ms**.
- **Payload Weight:** `/bitelevate` serves **220 KB** of uncompressed HTML, which could benefit from dynamic client code-splitting.

---

## Recommended Backend Improvements

1. **Decoupled Service Model:** Separate the public website from backend business logic using a standard Controller-Service-Repository pattern.
2. **Distributed Fixed-Window Rate Limiting:** Enforce request limits via an atomic Redis Lua script returning real remaining TTL (`PTTL`) and standard RFC 9333 headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`).
3. **Robust Token Authentication:** Verify HS256 JWTs using `jose`, enforce a 60-second clock-skew tolerance, require `exp`, validate minimum 256-bit key length (RFC 7518), and handle Redis revocation downtime distinctly (HTTP 503).
4. **Input Sanitization & Bot Mitigation:** Implement strict Zod schemas supporting international Unicode names (`\p{L}`) and anti-bot honeypot trapping.
5. **Database Abstraction & Caching:** Encapsulate database interactions with connection-pooled Prisma ORM and implement read-through Redis caching with explicit cache invalidation.

---

## Installation & Test Execution

### Prerequisites
- Node.js v18+ (tested on Node.js v22.13.1)
- npm v9+

### Setup
```powershell
# Clone the repository
git clone https://github.com/SOULShri/cynbit-backend-audit.git
cd cynbit-backend-audit

# Install dependencies
npm install
```

### Running Checks
```powershell
# Verify TypeScript strict compilation (zero errors)
npm run build

# Run complete test suite (54 unit/mock tests passed, 1 skipped)
npm test

# Run tests with coverage breakdown
npm run test:coverage
```

---

## Limitations and Ethical Boundaries

- **Single Session Telemetry:** Latency measurements represent empirical data from the audit session on October 30, 2026, and serve as diagnostic indicators rather than multi-week SLA benchmarks.
- **Unobservable Backend Controls:** Internal databases, serverless function limits, email dispatch workers, and WAF rules cannot be confirmed or denied from passive external observation.
- **Compliance:** All recommendations are proposed architectural designs intended for engineering assessment review and do not alter live Cynbit infrastructure.
