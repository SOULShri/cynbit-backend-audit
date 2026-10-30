# 03 — API and Endpoint Inventory

**Audit Target:** [https://www.cynbit.in/](https://www.cynbit.in/)  
**Inspection Protocol:** Passive telemetry, live HTTP inspection, and static client bundle analysis.  

---

## 1. Public Endpoint Surface Area

During passive network inspection across 14 public routes, the apex web application demonstrated the following network behaviors:

| Endpoint Path | Method | HTTP Status | Content-Type | Cache State | Latency | Size | Classification | Technical Notes |
|:---|:---|:---:|:---|:---:|:---:|:---:|:---|:---|
| `/` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 323ms | 100 KB | Marketing Document | ISR pre-rendered (`X-Nextjs-Prerender: 1`, stale: 300s). Terminated at Mumbai (`bom1`). |
| `/products` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 54ms | 82 KB | Marketing Document | ISR pre-rendered. Showcases Cynbit Studio, Revio, TenantEase. |
| `/services` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 59ms | 76 KB | Marketing Document | ISR pre-rendered. Covers AI Automation, Cloud Systems, Custom Software. |
| `/contact` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 49ms | 64 KB | Form Interface | ISR pre-rendered. Serves the contact inquiry form. |
| `/contact` | `OPTIONS` | 204 No Content | `N/A` | — | 48ms | 0 B | Preflight | Returns `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: OPTIONS, GET, HEAD`. |
| `/contact` *(Action: `submitInquiry`)* | `POST` | *Uninvoked* | `multipart/form-data` | — | — | — | React Server Action | Action ID `40247ba4465344b3386595bab4303317cdcce907df`. Not invoked during audit. |
| `/story` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 54ms | 60 KB | Marketing Document | ISR pre-rendered. |
| `/team` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 131ms | 61 KB | Marketing Document | ISR pre-rendered. |
| `/careers` | `GET` | 200 OK | `text/html; charset=utf-8` | MISS | 784ms | 125 KB | Dynamic SSR | Dynamic server-side rendering on each request (`Cache-Control: private, no-cache`). |
| `/blog` | `GET` | 200 OK | `text/html; charset=utf-8` | MISS | 832ms | 91 KB | Dynamic SSR | Dynamic SSR. Articles covering AI automation, engineering, and architecture. |
| `/bitelevate` | `GET` | 200 OK | `text/html; charset=utf-8` | HIT | 93ms | 220 KB | High-Payload ISR | Heavy initial document (220 KB raw HTML) containing extensive embedded state. |
| `/robots.txt` | `GET` | 200 OK | `text/plain; charset=utf-8` | HIT | 46ms | 200 B | Crawler Config | Disallows `/api/`, `/admin/`, `/portal/`. Specifies `Crawl-delay: 1`. |
| `/sitemap.xml` | `GET` | 200 OK | `application/xml` | MISS | 1,576ms | 14 KB | Dynamic XML | Generated dynamically on-the-fly. Significant origin compute latency. |
| `/api` | `GET` | 404 Not Found | `text/html; charset=utf-8` | MISS | 65ms | 3 KB | Route Check | Standard Next.js 404 page. Confirms no exposed default REST route under `/api`. |
| `/portal` | `GET` | 307 Temp Redirect | `text/plain` | — | 48ms | 0 B | Redirect | Redirects to `https://portal.cynbit.in/`. Confirms separation of client/admin portal. |

---

## 2. API Surface Observations & Boundaries

1. **Absence of Public REST API:** No public REST router or GraphQL schema is exposed under `/api` on the apex domain. External client integrations do not have a public API contract available.
2. **Third-Party Telemetry Streams:**
   - Google Analytics 4 (`gtag/js?id=G-LK6CQWCWX0`) is loaded asynchronously.
   - Material Symbols font is fetched from `fonts.googleapis.com`.
3. **Unobservable Backend Endpoints:**
   - Any private microservices, databases, or API routes supporting `portal.cynbit.in` were not inspected, in strict compliance with non-intrusive assessment boundaries.
