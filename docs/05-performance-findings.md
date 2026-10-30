# 05 — Performance Findings Report

**Audit Target:** [https://www.cynbit.in/](https://www.cynbit.in/)  
**Inspection Protocol:** Passive HTTP response telemetry and asset payload profiling.  
**Caveat:** Measurements reflect a single audit session; repeated multi-region sampling would be needed to establish statistically definitive latency baselines.  

---

## 1. Edge Caching vs. Origin Compute Performance

Inspection of Vercel Edge cache headers reveals a sharp contrast between pre-rendered marketing pages and dynamic SSR routes:

| Route Path | Cache Header (`X-Vercel-Cache`) | Next.js Prerender Header | Observed Latency | Document Size | Performance Assessment |
|:---|:---:|:---:|:---:|:---:|:---|
| `/contact` | `HIT` | `1` (stale: 300) | **49ms** | 64 KB | Excellent edge response time. |
| `/products` | `HIT` | `1` (stale: 300) | **54ms** | 82 KB | Excellent edge response time. |
| `/services` | `HIT` | `1` (stale: 300) | **59ms** | 76 KB | Excellent edge response time. |
| `/bitelevate` | `HIT` | `1` | **93ms** | 220 KB | Fast edge delivery, but high document weight. |
| `/careers` | `MISS` | *none* | **784ms** | 125 KB | Dynamic SSR origin render latency. |
| `/blog` | `MISS` | *none* | **832ms** | 91 KB | Dynamic SSR origin render latency. |
| `/sitemap.xml` | `MISS` | *none* | **1,576ms** | 14 KB | High compute latency for dynamic XML build. |

---

## 2. Key Observations & Bottlenecks

### 2.1 Edge Cache Efficiency (Observed)
Routes using Incremental Static Regeneration (ISR) consistently return HTTP 200 within **49ms to 93ms** from Vercel's Mumbai POP (`bom1`). This demonstrates effective edge CDN utilization for static content.

### 2.2 Origin Compute Latency on SSR Routes
- `/careers` (784ms) and `/blog` (832ms) bypass edge caching on each request (`Cache-Control: private, no-cache, no-store`).
- `/sitemap.xml` exhibits a **1,576ms** latency due to generating the full URL list dynamically on each request.
- **Engineering Trade-off:** While SSR guarantees real-time fresh content, blog articles and career listings rarely change by the minute. Converting these routes to ISR with an hourly or daily revalidation window would reduce server load and drop response latencies from ~800ms to <60ms.

### 2.3 Heavy Initial Document Size (`/bitelevate`)
- The `/bitelevate` page delivers **220 KB** of uncompressed initial HTML.
- Inspection shows this includes large serialized hydration scripts and pre-rendered curriculum paths.
- **Recommendation:** Implement client-side dynamic imports / code-splitting for curriculum tabs not immediately visible in the initial viewport.
