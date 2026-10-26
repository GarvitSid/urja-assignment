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

## 3.2 Meter Detail Scraping & Parallel Geo Mechanics

* **DOM Layout of Server-Rendered Nameplate:**
  * The `/meters/:id` endpoint returns server-rendered HTML.
  * Inside `<dl class="divide-y divide-slate-100">`, each `<dt>` and `<dd>` pair is wrapped within its own individual `<div>`:
    ```html
    <div class="flex justify-between py-1.5 text-sm">
      <dt class="text-slate-500">Meter ID</dt>
      <dd class="font-medium text-slate-800">J100000</dd>
    </div>
    ```
  * Utilizing `$(dt).next('dd')` guarantees pairing regardless of surrounding div wrappers.
* **Label Variation & Inconsistency:**
  * Different meter batches feature inconsistent label spacing:
    * Meter `J100000`: Spaced labels (`"Meter ID"`, `"Serial No"`, `"Phase Type"`, `"Installation Status"`, `"Installation Type"`).
    * Meter `J100004`: Concatenated labels (`"MeterId"`, `"SerialNo"`, `"PhaseType"`, `"InstallationStatus"`, `"InstallationType"`).
  * Robust normalization strips all internal whitespace and converts to lowercase: `rawKey.replace(/\s+/g, '').toLowerCase()`.
* **Parallel Location Fetching:**
  * Coordinates are not in the initial SSR HTML; they are fetched by client-side JS from `GET /portal/meters/:id/geo`.
  * The wrapper fires both requests concurrently via `Promise.allSettled()`, cutting endpoint latency in half.
  * If geo returns HTTP 404, the API returns `location: null` instead of failing the request.
  * Non-404 geo failures (HTTP 500 / timeout) are logged defensively without bringing down the response.
* **Input Validation & 404 Propagation:**
  * The `:id` parameter is validated against `/^[A-Z0-9]+$/i`; non-alphanumeric inputs immediately return HTTP 400 Bad Request.
  * If upstream returns 404 on the HTML page, the service maps it to HTTP 404 with uniform error envelope `{ "error": "not_found", "message": "Meter not found" }`.

---

## 3.3 Energy Telemetry Normalization & Monotonic Dial Semantics

* **Envelope Structure:**
  * `GET /portal/meters/:id/energy` returns `{ data: [ ...readings ] }` containing an array of reading objects.
* **Cumulative Dial Register Semantics:**
  * Empirical sampling across meters confirms that `kwh` values increase strictly monotonically over time:
    $$48438.74 \longrightarrow 48439.16 \longrightarrow 48439.58 \longrightarrow \dots \longrightarrow 48580.36$$
  * This proves that `kwh` is a cumulative mechanical dial register index rather than interval delta consumption.
* **The Empty String Coercion Trap:**
  * In JavaScript, `Number('') === 0` and `!isNaN('') === true`. Blindly casting upstream values during sensor dropouts causes empty strings to become fake zero readings.
  * `normalizeNumber(val)` uses `Number.isFinite()` and explicitly returns `null` for empty strings, null, undefined, NaN, and `Infinity`.
* **Timestamp Formatting & Timezone:**
  * Upstream timestamps are formatted as `"DD/MM/YYYY HH:mm"` (e.g. `"30/06/2026 23:00"`, verified day-first by values $> 12$).
  * Normalizes to ISO-8601 strings with explicit Indian Standard Time offset (`+05:30`): `"2026-06-30T23:00:00+05:30"`.
  * The original string is preserved under `rawTimestamp` for complete data traceability.
* **Tail Limiting (`?limit=N`):**
  * The readings array is chronologically sorted oldest to newest.
  * Passing `?limit=N` extracts the tail (`readings.slice(-limit)`), returning the latest $N$ readings in chronologically ascending order.
  * Limit values are validated; non-positive numbers, floats, or non-integer values return HTTP 400 Bad Request.

---

## 3.4 Electrical Network Topology & Absence of `/portal/feeders`

* **The Phantom Endpoint (`/portal/feeders`):**
  * Direct HTTP requests to `/portal/feeders` return HTTP 404 Not Found.
  * In the legacy SvelteKit architecture, Feeders are not an independent first-class entity endpoint.
* **Topological Linkage:**
  * Distribution Transformers (`GET /portal/dts?page=1`) provide `{ code, name, feederCode, capacityKva }`.
  * Meters (`GET /portal/meters/search`) provide `{ meterId, serialNo, dtCode, ... }`.
  * Meters have no direct `feederCode` attribute. The electrical distribution tree is reconstructed via a 3-tier topological join:
    $$\text{Feeder } (\text{from DT } \texttt{feederCode}) \longrightarrow \text{Distribution Transformer } (\texttt{dtCode}) \longrightarrow \text{Meters}$$
* **Dynamic DT Pagination:**
  * `GET /portal/dts?page=1` returns `{ total: 40, page: 1, pageSize: 20, data: [...] }`.
  * `totalPages = Math.ceil(total / pageSize)`. Dynamic multi-page traversal fetches all pages without hardcoding page numbers.
* **Orphan Isolation & 100% Meter Retention:**
  * In distribution grids, meters can be unassigned, decommissioned, or reference obsolete transformer codes.
  * Dropping unlinked meters leads to revenue leakage and unmonitored endpoints.
  * Any meter lacking a valid `dtCode` mapping is routed into an `UNASSIGNED` transformer bucket under an `UNASSIGNED` feeder branch, guaranteeing 100% meter retention ($N_{\text{in}} = N_{\text{out}}$).

---

## 3.5 Fast Bulk Export Endpoint (`/portal/export` & `/portal/keys`) & TTL Caching

* **Discovery via Client Bundle Inspection:**
  * Reverse-engineering the SvelteKit frontend bundle chunk `_app/immutable/nodes/4.*.js` (Transformers view) revealed an internal "Export all meters" routine using HMAC-SHA256 request signing.
* **Cryptographic Signing Protocol:**
  * **Signing Secret:** Fetched from `GET /portal/keys` (`{ data: { signingSecret: "..." } }`).
  * **Canonical Request String:** Formatted as a newline-delimited string:
    $$\texttt{canonical} = [\texttt{method}, \texttt{path}, \texttt{query}, \texttt{timestamp}].\text{join}('\backslash\text{n}')$$
    Example:
    ```text
    GET
    /portal/export
    page=1
    1719788400
    ```
  * **Signature Generation:** Computed via `HMAC-SHA256(signingSecret, canonical)` formatted as a 64-character lowercase hexadecimal digest.
  * **Required Request Headers:**
    * `x-timestamp`: Unix epoch in seconds (`Math.floor(Date.now() / 1000)`).
    * `x-signature`: Computed hexadecimal HMAC signature.
* **Performance Impact & Schema Normalization:**
  * While `GET /portal/meters/search` requires 21 sequential/parallel HTTP roundtrips (~2.5s) to paginate through 403 meters, `GET /portal/export?page=1` yields the entire 403-meter fleet in a single roundtrip (~150ms), reducing network overhead by >90%.
  * The export payload includes backend internal fields (7-tier geographic hierarchy and coordinates); the client normalizes each item to the standard 6-field fleet schema (`meterId`, `serialNo`, `make`, `phaseType`, `installStatus`, `dtCode`).
* **In-Memory TTL Cache & Single-Flight Mutex:**
  * Meter and transformer catalogs are cached in-memory with a 5-minute TTL (`CACHE_TTL_MS = 300000`).
  * An in-flight promise mutex (`metersInFlightPromise`) deduplicates concurrent cache-miss requests, eliminating "thundering herd" spikes against the legacy portal.
  * Consumers can force cache invalidation via the `?fresh=true` query parameter or `clearCache()` API.
* **Graceful Degradation & Automatic Fallback:**
  * If `/portal/keys` or `/portal/export` fails (e.g. key rotation, upstream 500 error, or signature rejection), `fetchMetersWithFallback()` automatically catches the error and degrades gracefully to paginated search (`/portal/meters/search`), ensuring high availability.

---



