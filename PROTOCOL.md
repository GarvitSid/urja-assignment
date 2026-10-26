# Urja Legacy Portal: Protocol & Reconnaissance Notes

> **Status:** Initial Discovery (Milestone 02)  
> *Note: This document records findings from live network inspection and will be expanded as each feature is implemented.*

---

## 1. Upstream Service Overview

* **Target URL:** `https://urja-ops.flockenergy.tech`
* **Architecture:** SvelteKit web application combining Server-Side Rendered (SSR) HTML pages with internal JSON data routes (`/portal/*`).
* **Authentication Method:** Stateful cookie-based session.

---

## 2. Authentication Flow & Session Quirks

### 2.1 Login Request
Inspecting the login network activity in DevTools reveals that authentication is not a standard REST JSON endpoint, but a **SvelteKit Form Action**:

* **Request:** `POST /login`
* **Content-Type:** `application/x-www-form-urlencoded`
* **Required Headers:**
  * `x-sveltekit-action: true` (Mandatory: SvelteKit ignores or rejects the action without this)
  * `Origin: https://urja-ops.flockenergy.tech`
  * `Referer: https://urja-ops.flockenergy.tech/login`
  * `Accept: application/json`
* **Payload:**
  ```text
  email=operator@urja.local&password=urja-ops-2026
  ```

### 2.2 Session Cookie
A successful login sets the following session cookie:
* **Name:** `__Secure-better-auth.session_token`
* **Attributes:** `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`

### 2.3 Observed Session Behavior
* Probing endpoints without this cookie (or with an expired token) results in either an HTTP `401 Unauthorized` or an HTTP `200 OK` that silently redirects to `/login`.
* An HTTP client must not treat an HTTP 200 containing login HTML as a valid data response; it must detect the redirection and trigger session re-authentication.

### 2.4 Client Session Healing & Interceptor Design
To handle session expiration transparently without caller disruption, the client implements an Axios response interceptor:
1. **Redirect Detection:** Detects when an unauthenticated request receives HTTP 200 containing HTML login form tags or `response.request.res.responseUrl` pointing to `/login`.
2. **Re-Authentication & Replay:** Automatically calls `authenticate()` to obtain a fresh session cookie, then replays the original request.
3. **Single-Retry Boundary:** Stamps requests with `_isRetry = true` to strictly prevent infinite re-auth loops if credentials become invalid.
4. **403 Forbidden Guard:** Never retries on HTTP 403 Forbidden (distinguishing CSRF/permission failures from expired sessions).
5. **Concurrency Mutex:** Groups concurrent unauthenticated requests so only a single login request is made (`loginPromise`), preventing thundering herds against the auth endpoint.

---

## 3. Discovered Endpoints (Initial Mapping)

During initial browser exploration, the following endpoints were observed:

| Method | Endpoint | Response Format | Purpose |
|---|---|---|---|
| `POST` | `/login` | SvelteKit Action | Establishes authenticated operator session |
| `GET` | `/portal/meters/search?q=&page=1` | JSON (`{ total, page, pageSize, data }`) | Paginated search of the meter fleet |
| `GET` | `/portal/dts?page=1` | JSON (`{ total, page, pageSize, data }`) | Paginated list of distribution transformers |
| `GET` | `/meters/:id` | SSR HTML (`text/html`) | Server-rendered meter detail view |
| `GET` | `/portal/meters/:id/geo` | JSON (`{ data: { latitude, longitude } }`) | Location coordinates loaded by the frontend |
| `GET` | `/portal/meters/:id/energy` | JSON (`{ data: [...] }`) | Historical energy telemetry series |

---

## 3.1 Meter Catalog & Search Parameter Quirks

* **Fleet Size & Pagination:**
  * `GET /portal/meters/search?q=&page=1` returns `{ total: 403, page: 1, pageSize: 20, data: [...] }`.
  * Total fleet consists of 403 meters across 21 pages ($20 \times 20 + 3 = 403$).
  * Dynamic pagination calculation: `totalPages = Math.ceil(total / pageSize)`.
* **Search Parameter (`q`) Indexing:**
  * Upstream `q` filters on `meterId` (e.g., `?q=J100001` yields 1 match) and `serialNo` (prefix/substring match).
  * **Upstream does NOT index `make`:** Querying `?q=Genus` returns 0 results upstream despite hundreds of Genus meters existing. Make filtering must be performed client-side.
* **Special Characters in Serials (`L&`):**
  * 77 meters feature serial numbers prefixed with `L&` (manufactured by L&T, e.g. `L&84997`).
  * If unencoded, the `&` character is interpreted by HTTP servers as a query string parameter separator (`?q=L&84997` breaks into parameter `q=L` and key `84997=`).
  * All search queries must be strictly encoded via `encodeURIComponent(q)`.
* **Parameter Coercion:**
  * Query parameters must be coerced via `String(q)` to prevent crashes from repeated query keys (e.g. `?q=a&q=b` which Express parses into an Array `['a', 'b']`).

---


