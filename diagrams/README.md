# Architecture & System Flow Diagrams

This directory contains visual models illustrating both the **empirically observed** architecture of `cynbit.in` and the **recommended decoupled backend architecture**.

---

## 1. Observed Request Flow (Next.js Server Actions)

> **Context:** Captures the client-to-server interaction on the `/contact` route identified through passive network inspection and client JavaScript bundle analysis. The Server Action reference was identified in the public bundle; form submission was deliberately **not invoked** during the audit to respect testing boundaries.

```mermaid
sequenceDiagram
    autonumber

    actor User as Client Browser
    participant Edge as Vercel Edge Network (Mumbai POP)
    participant NextApp as Next.js App Router
    participant Action as submitInquiry Action (ID: 40247ba4...)
    participant Backend as Unverified Backend Services (CRM / Email / DB)

    Note over User,Edge: Phase 1: Document Retrieval (Directly Observed)
    User->>Edge: GET /contact (HTTPS / TLS 1.3)
    Edge-->>User: 200 OK (ISR Pre-rendered HTML, 49ms, 64 KB)

    Note over User,Action: Phase 2: Action Registration in Client Bundle (Directly Observed)
    Note over User: Form loads client bundle: contact/page-a581c8d7462124d9.js<br/>Bundle contains: createServerReference("40247ba4...", d.callServer, ..., "submitInquiry")<br/>Exposes 5 form fields: fullName, email, company, industry, message

    Note over User,Edge: Phase 3: Next.js Server Action RPC Pattern (Deliberately NOT Invoked)
    Note over User,Edge: Assessment protocol boundary: Zero form submissions were dispatched.<br/>Transport mechanism per Next.js App Router specification:<br/>POST /contact (multipart/form-data) with Next-Action: 40247ba4...<br/>No public REST endpoint exists (e.g., /api/contact does not exist).
    User-->>Edge: [Uninvoked] POST /contact (multipart/form-data)
    Edge-->>NextApp: [Uninvoked] Forward RPC payload to Serverless Function
    NextApp-->>Action: [Uninvoked] Execute submitInquiry(formData)

    Note over Action,Backend: Phase 4: Server-Side Execution & Persistence (Unverified Boundary)
    Note over Backend: Server-side execution, CRM integration, database persistence,<br/>and transactional email delivery cannot be confirmed from public observation.
    Action--)Backend: [Unverified] Internal persistence / email dispatch

    Note over Action,User: Phase 5: Response Streaming (Architectural Specification — Not Captured)
    Note over Action,User: Live response payload was not observed because POST was not invoked.<br/>Next.js App Router specification returns RSC streaming state: { success: boolean }.
    Action-->>NextApp: [Uninvoked] Return status
    NextApp-->>Edge: [Uninvoked] RSC streaming payload
    Edge-->>User: [Uninvoked] Client state updated
```

- **Source File:** [`observed-request-flow.mmd`](./observed-request-flow.mmd)

---

## 2. Recommended Backend Architecture (Decoupled Services)

> **Context:** A target architecture blueprint designed for scaling Cynbit's SaaS products, AI automation services, and API integrations. Organizes responsibilities into discrete tiers using the Controller-Service-Repository pattern.

```mermaid
graph TB

    subgraph Client_Layer ["1. Client & Ingress Tier"]
        Client["Web / Mobile / Third-Party Clients"]
        EdgeWAF["Edge CDN & WAF (e.g., Cloudflare / Vercel Edge)<br/>• Edge Rate Limiting & Bot Filtering<br/>• Strict Security Header Injection (CSP, HSTS, X-Frame-Options)"]
    end

    subgraph Gateway_Layer ["2. API Gateway & Middleware Pipeline"]
        Gateway["Reverse Proxy & Gateway<br/>• Correlation ID Middleware (x-request-id)<br/>• Strict CORS Origin Whitelist"]
        RateLimit["Rate Limiting Middleware<br/>• Fixed-Window Atomic Lua Counter<br/>• RFC 9333 Headers (Limit, Remaining, Reset)<br/>• Process-Local In-Memory Fallback"]
        AuthGuard["Authentication & Authorization Guard<br/>• Cryptographic JWT Verification (jose HS256)<br/>• 60s Clock-Skew Tolerance<br/>• RBAC Middleware (requireRoles)"]
    end

    subgraph App_Layer ["3. Application Services Tier (Node.js / Express / NestJS)"]
        Controller["Inquiry Controller<br/>• DTO extraction & status orchestration<br/>• Standardized ApiResponse envelope"]
        Validation["Zod Validation Layer<br/>• Runtime schema parsing<br/>• Unicode name support<br/>• Anti-bot honeypot trapping"]
        Service["Inquiry Business Service<br/>• Domain business logic & transactions<br/>• Async worker job dispatching"]
        Repository["Inquiry Repository<br/>• Typed Prisma ORM query builder<br/>• Read-through cache coordination"]
    end

    subgraph Cache_Queue ["4. Cache & Async Worker Tier"]
        Redis[("Redis Cluster<br/>• Atomic rate limit counters\n• Session revocation store\n• Read-through query cache")]
        BullMQ["BullMQ / Message Queue<br/>• Asynchronous email & webhook queuing<br/>• Retry policies & dead-letter queues"]
        Workers["Background Async Workers<br/>• Transactional email dispatch<br/>• AI agent orchestration & webhooks"]
    end

    subgraph Persistence_Layer ["5. Data Persistence Tier"]
        PgBouncer["Connection Pooler (PgBouncer)<br/>• Mitigates connection exhaustion"]
        Postgres[("PostgreSQL 16 (Primary OLTP)<br/>• Relational tables & indexes<br/>• Parameterized queries (SQLi immune)")]
        Replica[("Read Replica (Optional)<br/>• Dedicated analytics & dashboard reads")]
    end

    subgraph Observability_Tier ["6. Observability & Monitoring"]
        Logging["Structured JSON Logger (Pino)<br/>• Unified logs with correlation requestId"]
        Sentry["Error Tracking & Alerting (Sentry)<br/>• Intercepts uncaught exceptions"]
        Metrics["Prometheus / OpenTelemetry Metrics<br/>• Real-time latency, throughput, and error rates"]
    end

    %% Flows
    Client -->|"HTTPS / TLS 1.3"| EdgeWAF
    EdgeWAF --> Gateway
    Gateway --> RateLimit
    RateLimit -->|"Public routes (POST inquiries)"| Controller
    RateLimit -->|"Protected routes (GET inquiries)"| AuthGuard
    AuthGuard --> Controller
    Controller --> Validation
    Validation --> Service
    Service --> Repository

    %% Infrastructure Links
    RateLimit -.->|"atomic PTTL check"| Redis
    AuthGuard -.->|"session revocation check"| Redis
    Repository -.->|"read-through cache / del"| Redis
    Service -.->|"enqueue async tasks"| BullMQ
    BullMQ --> Workers
    Repository --> PgBouncer
    PgBouncer --> Postgres
    Postgres -.->|"streaming replication"| Replica
```

- **Source File:** [`recommended-architecture.mmd`](./recommended-architecture.mmd)

---

## 3. Security & Validation Request Processing Flow

> **Context:** Step-by-step lifecycle of API requests aligned with [`recommendations/api-example.ts`](../recommendations/api-example.ts). Inquiry creation (`POST /api/v1/inquiries`) is public, rate-limited, and schema-validated; inquiry listing and retrieval (`GET /api/v1/inquiries`) require cryptographic JWT verification and RBAC authorization.

```mermaid
sequenceDiagram
    autonumber

    actor Client as API Client / Consumer
    participant Gateway as API Gateway / Router
    participant RL as Rate Limiter (Redis Lua)
    participant Auth as JWT Auth Guard (jose HS256)
    participant RBAC as Role Guard (requireRoles)
    participant Val as Input Validator (Zod)
    participant Svc as Inquiry Service & DB Layer
    participant Err as Centralized Error Handler

    %% ─────────────────────────────────────────────────────────────────────────────
    %% Branch 1: Public Inquiry Submission
    %% ─────────────────────────────────────────────────────────────────────────────
    Note over Client,Gateway: Route 1: Public Inquiry Submission (POST /api/v1/inquiries)
    Client->>Gateway: POST /api/v1/inquiries (JSON payload — No Auth Token Required)
    Gateway->>Gateway: Inject correlation ID (x-request-id) & resolve client IP

    Note over Gateway,RL: 1. Perimeter IP Rate Limiting (Public Endpoint)
    Gateway->>RL: Check rate threshold for client IP
    alt IP Limit Exceeded
        RL-->>Client: 429 Too Many Requests (RateLimit-Limit, Remaining, Reset, Retry-After)
    else Within Rate Limit
        RL->>Val: Forward directly to validation (Bypasses Auth & RBAC)

        Note over Val,Val: 2. Zero-Trust Input Validation (CreateInquirySchema)
        Val->>Val: Check honeypot trap, normalize email, sanitize Unicode name
        alt Validation Fails or Honeypot Triggered
            Val-->>Client: 400 Bad Request (Field-level validation error envelope)
        else Validation Passes
            Val->>Svc: Invoke inquiryService.createInquiry(dto, clientIp)
            alt Database Failure / Constraint Violation
                Svc->>Err: Bubble error to centralized handler
                Err->>Err: Intercept error, mask DB internals (Prisma P-codes), log JSON
                Err-->>Client: 500 Internal Server Error (Sanitized envelope)
            else Successful Persistence
                Svc-->>Client: 201 Created ({ success: true, data: { id, status: "PENDING" } })
            end
        end
    end

    %% ─────────────────────────────────────────────────────────────────────────────
    %% Branch 2: Protected Admin/Engineer Queries
    %% ─────────────────────────────────────────────────────────────────────────────
    Note over Client,Gateway: Route 2: Protected Inquiries Query (GET /api/v1/inquiries)
    Client->>Gateway: GET /api/v1/inquiries (Header: Authorization: Bearer <JWT>)
    Gateway->>Gateway: Inject correlation ID (x-request-id)

    Note over Gateway,RL: 1. Rate Limiting Check
    Gateway->>RL: Check caller threshold
    alt Rate Limit Exceeded
        RL-->>Client: 429 Too Many Requests
    else Within Rate Limit
        RL->>Auth: Pass request forward

        Note over RL,Auth: 2. Cryptographic JWT Signature Verification
        Auth->>Auth: Verify JWT signature (HS256 allowlist, 32+ byte secret)
        Auth->>Auth: Validate claims: exp, iss, aud, sub, roles
        Auth->>Auth: Check iat against current time (60s clock-skew tolerance)
        Auth->>Auth: Query Redis session revocation store
        alt Token Expired / Forged / Missing exp / Future iat
            Auth-->>Client: 401 Unauthorized (INVALID_TOKEN)
        else Session Revoked
            Auth-->>Client: 401 Unauthorized (SESSION_REVOKED)
        else Redis Revocation Infrastructure Down
            Auth-->>Client: 503 Service Unavailable (REVOCATION_SERVICE_UNAVAILABLE)
        else Token Authenticated
            Auth->>RBAC: Attach req.user context and forward

            Note over Auth,RBAC: 3. Role-Based Access Control (RBAC Guard)
            RBAC->>RBAC: Verify req.user.roles includes 'ADMIN' or 'ENGINEER'
            alt Lacks Permitted Role
                RBAC-->>Client: 403 Forbidden (FORBIDDEN)
            else Role Authorized
                RBAC->>Val: Forward query parameters

                Note over RBAC,Val: 4. Query Schema Validation (InquiryQuerySchema)
                Val->>Val: Validate page, limit, status, industry filters
                alt Query Parameters Invalid
                    Val-->>Client: 400 Bad Request
                else Query Valid
                    Val->>Svc: Invoke inquiryService.getInquiries(query)
                    Svc->>Svc: Query read-through cache (Redis) & PostgreSQL
                    Svc-->>Client: 200 OK ({ success: true, data: [...], meta: { page, total } })
                end
            end
        end
    end
```

- **Source File:** [`security-request-flow.mmd`](./security-request-flow.mmd)

---

## 4. Standalone Interactive Visualizer

For an interactive browser experience with dynamic zoom, panning, dark/light theme switching, and tab navigation, open [`index.html`](./index.html) in any modern browser.
