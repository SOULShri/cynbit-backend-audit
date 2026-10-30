# Architecture & System Flow Diagrams

This directory contains visual models illustrating both the **empirically observed** architecture of `cynbit.in` and the **recommended decoupled backend architecture**.

---

## 1. Observed Request Flow (Next.js Server Actions)

> **Context:** Captures the actual client-to-server interaction on the `/contact` route verified through passive network inspection and JavaScript bundle analysis. Server-side processing beyond the Server Action entrypoint was unobservable and is explicitly marked as unverified.

```mermaid
sequenceDiagram
    autonumber

    actor User as Client Browser
    participant Edge as Vercel Edge Network (Mumbai POP)
    participant NextApp as Next.js App Router
    participant Action as submitInquiry Server Action (ID: 40247ba4...)
    participant Backend as Unverified Backend Services (CRM / Email / DB)

    Note over User,Edge: Phase 1: Document Retrieval (Observed)
    User->>Edge: GET /contact (HTTPS / TLS 1.3)
    Edge-->>User: 200 OK (ISR Pre-rendered HTML, 49ms, 64 KB)
    Note over User: Form loads client bundle: contact/page-*.js<br/>User inputs: fullName, email, company, industry, message

    Note over User,Action: Phase 2: Form Submission RPC (Observed Mechanism)
    User->>Edge: POST /contact (multipart/form-data)
    Note over User,Edge: Header: Next-Action: 40247ba4465344b3386595bab4303317cdcce907df<br/>Transported via internal React Server Action callServer RPC.<br/>No public REST endpoint exists (e.g., /api/contact does not exist).
    Edge->>NextApp: Forward RPC payload to Serverless Function
    NextApp->>Action: Execute submitInquiry(formData)

    Note over Action,Backend: Phase 3: Server-Side Execution (Unverified Boundary)
    Action-)Backend: Internal persistence / email dispatch (Unobservable)
    Note over Backend: Exact internal datastore, CRM integration,<br/>or email service cannot be confirmed from public observation.
    Backend--)Action: Internal status returned

    Note over Action,User: Phase 4: Response Streaming (Observed)
    Action-->>NextApp: Return status { success: boolean }
    NextApp-->>Edge: React Server Component streaming payload
    Edge-->>User: Client state updated (Render success animation or error banner)
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
        AuthGuard["Authentication & Authorization Guard<br/>• Timing-Safe JWT Verification (jose HS256)<br/>• 60s Clock-Skew Tolerance<br/>• RBAC Middleware (requireRoles)"]
    end

    subgraph App_Layer ["3. Application Services Tier (Node.js / Express / NestJS)"]
        Controller["Inquiry Controller<br/>• DTO extraction & status orchestration<br/>• Standardized ApiResponse envelope"]
        Validation["Zod Validation Layer<br/>• Runtime schema parsing<br/>• Unicode name support<br/>• Anti-bot honeypot trapping"]
        Service["Inquiry Business Service<br/>• Domain business logic & transactions<br/>• Async worker job dispatching"]
        Repository["Inquiry Repository<br/>• Typed Prisma ORM query builder<br/>• Read-through cache coordination"]
    end

    subgraph Cache_Queue ["4. Cache & Async Worker Tier"]
        Redis[("Redis Cluster<br/>• Atomic rate limit counters<br/>• Session revocation store<br/>• Read-through query cache")]
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
    RateLimit --> AuthGuard
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

    %% Observability taps
    Controller -.-> Logging
    Service -.-> Sentry
    Gateway -.-> Metrics
```

- **Source File:** [`recommended-architecture.mmd`](./recommended-architecture.mmd)

---

## 3. Security & Validation Request Processing Flow

> **Context:** Step-by-step lifecycle of a secure backend mutation request, detailing defense-in-depth enforcement from edge rate limiting through authentication, role checks, validation, business execution, and centralized error handling.

```mermaid
sequenceDiagram
    autonumber

    actor Client as API Client / Consumer
    participant Gateway as API Gateway / Router
    participant RL as Rate Limiter (Redis Lua)
    participant Auth as JWT Middleware (jose)
    participant RBAC as Role Guard (requireRoles)
    participant Val as Input Validator (Zod)
    participant Svc as Business Service Layer
    participant Err as Centralized Error Handler

    Client->>Gateway: POST /api/v1/inquiries (Bearer Token + JSON Payload)
    Gateway->>Gateway: Inject x-request-id & resolve client IP

    Note over Gateway,RL: 1. Rate Limiting Check
    Gateway->>RL: Check rate threshold for client IP
    alt Limit Exceeded (Over threshold)
        RL-->>Client: 429 Too Many Requests (RateLimit-Reset, Retry-After per RFC 6585/9333)
    else Within Limit
        RL->>Auth: Pass request forward

        Note over RL,Auth: 2. Authentication & Integrity Check
        Auth->>Auth: Verify JWT signature (HS256 allowlist, 32+ byte secret)
        Auth->>Auth: Validate claims: exp, iss, aud, sub, roles
        Auth->>Auth: Check iat against current time (60s clock-skew tolerance)
        Auth->>Auth: Query session revocation store in Redis
        alt Token Expired / Forged / Revoked
            Auth-->>Client: 401 Unauthorized (INVALID_TOKEN or SESSION_REVOKED)
        else Redis Revocation Infrastructure Down
            Auth-->>Client: 503 Service Unavailable (REVOCATION_SERVICE_UNAVAILABLE)
        else Token Authenticated
            Auth->>RBAC: Attach req.user context and forward

            Note over Auth,RBAC: 3. Role-Based Access Control (RBAC)
            RBAC->>RBAC: Verify req.user.roles contains permitted role(s)
            alt Lacks Required Role
                RBAC-->>Client: 403 Forbidden (FORBIDDEN)
            else Role Authorized
                RBAC->>Val: Forward to route controller

                Note over RBAC,Val: 4. Zero-Trust Input Validation
                Val->>Val: Execute Zod schema validation (safeParseAsync)
                Val->>Val: Check honeypot trap, normalize email, sanitize Unicode name
                alt Input Invalid or Honeypot Triggered
                    Val-->>Client: 400 Bad Request (Field-level validation error envelope)
                else Input Validated
                    Val->>Svc: Invoke business service with typed DTO

                    Note over Val,Svc: 5. Business Logic & Persistence
                    Svc->>Svc: Execute domain operations & database transactions
                    alt Unhandled Exception / Database Constraint Error
                        Svc->>Err: Bubble error to centralized handler
                        Err->>Err: Intercept error, mask DB internals (Prisma P-code), log JSON
                        Err-->>Client: 500 Internal Server Error (Sanitized error envelope)
                    else Successful Execution
                        Svc-->>Client: 201 Created (Standardized ApiResponse envelope)
                    end
                end
            end
        end
    end
```

- **Source File:** [`security-request-flow.mmd`](./security-request-flow.mmd)

---

## 4. Standalone Interactive Visualizer

For an interactive browser experience with dynamic zoom, panning, dark/light theme switching, and tab navigation, open [`index.html`](./index.html) in any modern browser.
