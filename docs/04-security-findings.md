# 04 — Security Findings Report

**Audit Target:** [https://www.cynbit.in/](https://www.cynbit.in/)  
**Evaluation Scope:** Transport security, edge HTTP security headers, and client-side anti-abuse posture.  
**Classification:** Passive External Security Review  

---

## 1. Transport Security Posture (Verified)

| Parameter | Observed Value | Evaluation | Notes |
|:---|:---|:---:|:---|
| **Protocol** | TLS 1.3 | **Strong** | Modern protocol; eliminates legacy cipher negotiation weaknesses. |
| **Cipher Suite** | `TLS_AES_128_GCM_SHA256` | **Strong** | Authenticated encryption with associated data (AEAD); forward secrecy guaranteed. |
| **Certificate Authority** | Let's Encrypt (CN: `YR2`) | **Valid** | Active, valid domain-validated certificate. |
| **HSTS** | `max-age=63072000` | **Strong** | 2-year Strict-Transport-Security policy enforced; mitigates SSL-stripping attacks. |

---

## 2. Security Header Hardening Gaps

### SEC-01: Global Wildcard CORS Header (`Access-Control-Allow-Origin: *`)
- **Category:** Application Security / CORS Hardening
- **Observed Behavior:** Responses return `Access-Control-Allow-Origin: *` across marketing routes and preflight `OPTIONS` requests.
- **Risk Assessment:** For public static marketing assets, wildcard CORS is benign. However, if future authenticated endpoints (e.g. under `/portal` or API routes) inherit this configuration, cross-origin scripts could read sensitive responses if credentials are misconfigured.
- **Recommendation:** Implement an explicit origin whitelist restricting CORS to authorized Cynbit domains:
  ```typescript
  const allowedOrigins = ['https://www.cynbit.in', 'https://portal.cynbit.in'];
  ```

### SEC-02: Missing Content Security Policy (CSP)
- **Category:** Defence-in-Depth
- **Observed Behavior:** No `Content-Security-Policy` header is returned on any audited page.
- **Risk Assessment:** The absence of a CSP is not proof of an active XSS vulnerability. However, it removes a critical layer of defense-in-depth, allowing unauthorized third-party scripts to execute if an injection vulnerability ever occurs.
- **Recommendation:** Configure a strict CSP header disallowing inline scripts without cryptographic nonces:
  ```http
  Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-...' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; object-src 'none'; base-uri 'self';
  ```

### SEC-03: Missing Clickjacking Protection (`X-Frame-Options` / `frame-ancestors`)
- **Category:** Frame Sandboxing
- **Observed Behavior:** Neither `X-Frame-Options` nor CSP `frame-ancestors` are returned.
- **Risk Assessment:** Allows external malicious domains to embed `cynbit.in` inside `<iframe>` containers, creating a potential clickjacking risk if interactive user actions are targeted.
- **Recommendation:**
  ```http
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none';
  ```

### SEC-04: Missing MIME-Sniffing Protection (`X-Content-Type-Options`)
- **Category:** MIME Handling
- **Observed Behavior:** `X-Content-Type-Options: nosniff` is absent from HTTP responses.
- **Risk Assessment:** Older or non-standard user agents may attempt to sniff response content types, potentially interpreting user uploads or text resources as executable scripts.
- **Recommendation:**
  ```http
  X-Content-Type-Options: nosniff
  ```

### SEC-05: Missing Explicit Referrer Policy
- **Category:** Information Leakage Prevention
- **Observed Behavior:** No `Referrer-Policy` header is explicitly configured.
- **Context:** Modern browsers (Chrome, Firefox, Safari) default to `strict-origin-when-cross-origin`. However, an explicit header ensures consistent behavior across all clients and prevents sensitive URL query parameters from leaking to external destinations.
- **Recommendation:**
  ```http
  Referrer-Policy: strict-origin-when-cross-origin
  ```

### SEC-06: Missing Permissions Policy
- **Category:** Browser Feature Hardening
- **Observed Behavior:** `Permissions-Policy` (formerly `Feature-Policy`) is absent.
- **Risk Assessment:** Browser hardware features (microphone, camera, geolocation, payments) are not explicitly restricted, increasing attack surface if third-party scripts are compromised.
- **Recommendation:**
  ```http
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  ```

### SEC-07: Contact Form Anti-Abuse Posture
- **Category:** Form Protection & Rate Limiting
- **Observed Behavior:** Client bundle analysis confirms that the contact form collects five text inputs and dispatches via Server Action without observable client-side CAPTCHA tokens (e.g. Cloudflare Turnstile, reCAPTCHA).
- **Nuance:** Whether Cynbit enforces backend IP throttling, WAF rules, or rate limiting cannot be confirmed or denied without submitting forms (which was prohibited by audit rules).
- **Recommendation:** Ensure robust backend rate limiting (e.g. 5 submissions per 15 minutes per IP via Redis atomic fixed-window counter) combined with an anti-bot honeypot.
