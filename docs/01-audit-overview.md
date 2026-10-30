# 01 — Audit Overview and Methodology

**Target:** [https://www.cynbit.in/](https://www.cynbit.in/)  
**Role:** Backend Developer Intern Assessment  
**Audit Protocol:** Passive inspection; zero intrusive testing, zero form submissions, zero automated fuzzing.  
**Telemetry Date:** October 30, 2026  

---

## 1. Executive Summary

Cynbit Technologies is a software solutions provider specializing in AI agent automation, custom software systems, and educational training programs (BitElevate).

This technical audit evaluates the public digital infrastructure of `cynbit.in` from an independent backend engineering perspective. The evaluation is grounded strictly in passive telemetry, HTTP/TLS inspection, and publicly served client JavaScript bundle analysis.

### Primary Observations
- **Hosting & Infrastructure:** Deployed on the **Vercel Edge Network**, with traffic observed terminating at the Mumbai point-of-presence (`bom1`).
- **Application Architecture:** Developed using **Next.js App Router** with React Server Components (RSC) and React Server Actions.
- **API Surface:** No public REST or GraphQL API exists under `/api` on the apex domain. Contact inquiry submissions are handled through internal Next.js Server Action RPC calls.
- **Transport Security:** High grade (TLS 1.3, AES-128-GCM cipher suite, valid Let's Encrypt certificate, and 2-year HSTS).
- **Application Hardening Gaps:** Missing Content Security Policy (CSP), missing `X-Frame-Options`, missing `X-Content-Type-Options: nosniff`, and a global wildcard CORS header (`*`).
- **Performance Characteristics:** Pre-rendered Incremental Static Regeneration (ISR) pages respond rapidly (**49ms – 131ms**). Fully dynamic Server-Side Rendered (SSR) routes (`/careers`, `/blog`, and `/sitemap.xml`) show origin computation latencies between **780ms and 1,576ms**.

---

## 2. Assessment Protocol and Safety Boundaries

In accordance with strict ethical standards:
- **No Exploits:** No SQL injection, cross-site scripting payloads, or header tampering were dispatched.
- **No Form Spam:** The contact form Server Action (`submitInquiry`) was inspected purely through client bundle analysis; zero submissions were sent.
- **No Heavy Scanning:** Automated vulnerability scanners, brute-force crawlers, and load-testing tools were completely avoided.
- **No Credential Access:** No attempts to bypass authentication or probe private subdomains.

---

## 3. Evidence Classification Framework

Throughout this audit, statements are classified into three distinct categories:

| Classification | Definition | Example in this Report |
|:---|:---|:---|
| **Observed** | Directly verified via public HTTP responses, TLS handshakes, or client bundle artifacts. | Next.js Server Action ID `40247ba4...` bound in `contact/page-*.js`. |
| **Inferred** | A technically sound hypothesis based on standard architectural patterns, but unprovable from public endpoints. | Behind `submitInquiry`, Cynbit likely routes inquiries to an email gateway or transactional CRM. |
| **Recommended** | An engineering improvement proposed for scalable backend development, not a claim about Cynbit's current system. | Implementing a Redis-backed fixed-window rate limiter with RFC 9333 headers. |
