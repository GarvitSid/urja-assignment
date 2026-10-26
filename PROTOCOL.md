# Urja Meter Ops Portal — Protocol & Reverse-Engineering Specification

This document details how the legacy **Urja Meter Ops** portal (`https://urja-ops.flockenergy.tech`) actually operates. It synthesizes findings gathered through browser DevTools network inspection, client-side SvelteKit bundle reverse-engineering, and programmatic verification against the live system.

---

## 1. Authentication & Session Lifecycle

### Login Flow
- **Endpoint:** `POST https://urja-ops.flockenergy.tech/login`
- **Content-Type:** `application/x-www-form-urlencoded`
- **Body:** `email={email}&password={password}`
- **Required Header:** `x-sveltekit-action: true`
  - SvelteKit uses this header to distinguish form actions from normal browser page navigations. Without it, the backend treats the POST as a page navigation and returns an HTML redirect without processing authentication.
- **CSRF & Origin Validation:**
  - The portal rejects requests that do not carry `Origin` and `Referer` headers matching its own origin (`https://urja-ops.flockenergy.tech`). Direct HTTP POST requests omitting these headers fail with `403 Forbidden`.
- **Session Cookie:**
  - On successful authentication, the server sets a session cookie:
    ```http
    Set-Cookie: __Secure-better-auth.session_token=<token>; Path=/; HttpOnly; Secure; SameSite=Lax
    ```
  - This cookie must be retained in an HTTP cookie jar and attached to every subsequent request. There is no Bearer token or secondary API key mechanism for standard routes.

### Session Expiry & Redirect Behavior
- When an authenticated session expires, SvelteKit issues an HTTP redirect to `/login`.
- For standard HTTP clients following redirects (such as Axios), this produces an `HTTP 200 OK` response containing the HTML login form (`<form action="/login">`) instead of the requested JSON or data payload.
- The wrapper client monitors incoming responses for HTML login form markers and HTTP 401 statuses. When detected, it flags the session as expired, re-authenticates with the configured credentials, and replays the original request transparently.

---

## 2. Discovered Internal Endpoints & Specifications

The portal is a SvelteKit single-page application. Most in-app navigations fire background `fetch` requests for JSON rather than performing full page reloads.

### A. Meter Search & Catalog (Paginated)
- **Endpoint:** `GET /portal/meters/search?q={query}&page={page_number}`
- **Response Format:**
  ```json
  {
    "total": 403,
    "page": 1,
    "pageSize": 20,
    "data": [
      {
        "meterId": "J100000",
        "serialNo": "SE33962",
        "make": "HPL",
        "phaseType": "single",
        "installStatus": "Decommissioned",
        "dtCode": "DT-001"
      }
    ]
  }
  ```
- **Characteristics & Quirks:**
  - **Pagination:** Fixed `pageSize` of 20. The catalog contains **403 meters across 21 pages** (`Math.ceil(total / pageSize)`). Walking this list sequentially requires 21 downstream HTTP requests.
  - **Search Parameter (`q`):** Performs substring/prefix matching against `meterId` and `serialNo`. It does not filter by `make` or `dtCode`.
  - **Ampersands in Serials:** 77 meters have serial numbers containing `&` (e.g., `L&84997`, representing L&T manufacture). Direct queries like `?q=L&84997` without URL encoding split the query string into separate keys (`q=L` and `84997=`). Clients querying the upstream portal directly must URL-encode query values.
  - **Grid Association:** Meters carry `dtCode` but do not contain a direct `feederCode` field. Grid association must be resolved through the Distribution Transformers.

---

### B. Distribution Transformers (DTs)
- **Endpoint:** `GET /portal/dts?page={page_number}`
- **Response Format:**
  ```json
  {
    "total": 40,
    "page": 1,
    "pageSize": 20,
    "data": [
      {
        "code": "DT-001",
        "name": "Malviya Nagar DT 1",
        "capacityKva": 100,
        "feederCode": "F-001"
      }
    ]
  }
  ```
- **Characteristics:**
  - Contains **40 distribution transformers across 2 pages** (20 per page). Requesting `page=3` returns `data: []`.
  - DT records bridge meters to substation feeders (`feederCode`).
  - Search or filter query parameters are ignored by this endpoint.

---

### C. Meter Details (Nameplate HTML) vs. The `devalue` Quirk
- **Endpoints:**
  - Server-rendered HTML: `GET /meters/{meter_id}`
  - Internal SvelteKit JSON: `GET /meters/{meter_id}/__data.json?x-sveltekit-invalidated=001`
- **The `devalue` Serialization Quirk:**
  - The portal's internal `__data.json` endpoint uses SvelteKit's `devalue` format. Instead of conventional key/value pairs, all values are flattened into an array, and objects store integer pointers into that array (e.g. `"Installation Status"` maps to an index integer, not the string value).
  - *Engineering Decision:* Writing a deserializer for private `devalue` index pointers was rejected as fragile, since the indexing scheme is an internal framework detail that can change across minor SvelteKit releases.
  - *Scraping Approach:* The wrapper requests server-rendered HTML at `GET /meters/{meter_id}` and parses the nameplate `<dt>`/`<dd>` pairs with Cheerio.
- **Inconsistent Nameplate Markup:**
  - Markup structure varies across records:
    - Spaced labels: `J100001` renders `<dt>Serial No</dt>` and `<dt>Installation Status</dt>`.
    - Concatenated labels: `J100004` renders `<dt>SerialNo</dt>` and `<dt>InstallationStatus</dt>`.
    - Wrapper elements: Tags are wrapped in parent `<div>` elements inside `<dl>`.
  - The parser normalizes keys by stripping whitespace, colons, and non-alphanumeric characters (`replace(/[^a-zA-Z0-9]/g, '').toLowerCase()`), ensuring reliable field extraction regardless of markup formatting.
- **Non-Existent Meter IDs:**
  - Requesting an invalid meter (e.g. `GET /meters/INVALID_ID`) returns an HTTP 404 status with a SvelteKit error page (`<h1>404</h1> <p>Meter not found</p>`).

---

### D. Meter Location (Geo Coordinates) — Client-Side Deferred Loading
- **Endpoint:** `GET /portal/meters/{meter_id}/geo`
- **Response Format:**
  ```json
  {
    "data": {
      "latitude": "26.822136543835608",
      "longitude": "75.90718190602279"
    }
  }
  ```
- **Quirk (Client-Side Deferred Loading):**
  - GPS coordinates are omitted from the server-rendered HTML. The SSR page delivers a placeholder (`<div class="badge">Loading location...</div>`) and fires a secondary client-side fetch to `/portal/meters/{id}/geo` after mounting.
  - The wrapper queries the HTML page and the `/geo` endpoint concurrently via `Promise.all`.
  - Coordinates place the meters in the Jaipur metropolitan area in Rajasthan, India (Latitude `26.8°–27.0° N`, Longitude `75.7°–75.9° E`).

---

### E. Meter Energy Consumption Telemetry
- **Endpoint:** `GET /portal/meters/{meter_id}/energy`
- **Response Format:**
  ```json
  {
    "data": [
      {
        "timestamp": "23/06/2026 23:30",
        "kwh": "48438.74",
        "kvah": "52313.84",
        "voltR": "226"
      },
      {
        "timestamp": "24/06/2026 00:00",
        "kwh": "48439.16",
        "kvah": "52314.29",
        "voltR": "229"
      }
    ]
  }
  ```
- **Quirks & Semantics:**
  - **Strings as Numbers:** Numeric values (`kwh`, `kvah`, `voltR`) are sent as strings and must be parsed safely (converting empty strings to `null` to avoid JavaScript's `Number('') === 0` coercion).
  - **Cumulative Dial Registers:** Chronological readings exhibit strictly monotonically increasing `kwh` values. This confirms the telemetry represents a cumulative meter dial register, not interval delta consumption.
  - **Timezone:** Timestamps use `"DD/MM/YYYY HH:mm"`. Because the utility operates in Jaipur, Rajasthan, timestamps represent Indian Standard Time (IST, UTC+05:30). The wrapper converts these into ISO-8601 strings with an explicit `+05:30` offset.
  - **Sampling Variation:** Some meters (e.g. `J100000`) contain 337 half-hourly readings (~7 days), while others contain 8 weekly or daily snapshots.

---

### F. Fast Bulk Export Endpoint (`/portal/export` & `/portal/keys`)
- **Discovery via Client Bundle Inspection:**
  Inspecting the client-side Vite bundle chunk `_app/immutable/nodes/4.2Bgc2kUI.js` (the Transformers view) revealed an internal "Export all meters" function. The minified handler contained the HMAC signing logic:
  ```javascript
  // Literal snippet from _app/immutable/nodes/4.2Bgc2kUI.js:
  async function C(e,t,n,r){let i=String(Math.floor(Date.now()/1e3)),a=[e,t,n,i].join(`\n`),o=await crypto.subtle.importKey(`raw`,new TextEncoder().encode(r),{name:`HMAC`,hash:`SHA-256`},!1,[`sign`]),s=await crypto.subtle.sign(`HMAC`,o,new TextEncoder().encode(a));return{timestamp:i,signature:[...new Uint8Array(s)].map(e=>e.toString(16).padStart(2,`0`)).join(``)}}
  ```
  Parameter mapping:
  - `e`: HTTP method (`"GET"`)
  - `t`: Request path (`"/portal/export"`)
  - `n`: Query string (`"page=1"`)
  - `r`: Signing secret fetched from `GET /portal/keys`
  - `i`: Integer UNIX timestamp in seconds
  - `a`: Newline-delimited canonical string (`"GET\n/portal/export\npage=1\n{timestamp}"`)
  - `s`: HMAC-SHA256 signature formatted as a 64-character lowercase hexadecimal string
- **Signing Key Route:**
  `GET /portal/keys` returns:
  ```json
  {
    "data": {
      "signingSecret": "<REDACTED_PORTAL_SIGNING_SECRET>"
    }
  }
  ```
- **Bulk Payload Returned:**
  Calling `GET /portal/export?page=1` with valid `x-timestamp` and `x-signature` headers returns all 403 meters in a single ~150 ms response. The raw export payload contains the backend's internal 7-tier hierarchy (`zone -> circle -> division -> subdivision -> substation -> feeder -> dt`) and coordinates.
- **Schema Normalization:**
  The wrapper normalizes the bulk export catalog to match the 6 standard fields of the search endpoint (`meterId`, `serialNo`, `make`, `phaseType`, `installStatus`, `dtCode`), while reconstructing the electrical hierarchy through `/portal/dts`. This guarantees that `/api/v1/meters` returns an identical, predictable schema whether served from fast bulk export or sequential pagination fallback.

---

## 3. Data Anomalies & Quirks Summary

1. **`DT-007` Spatial Scatter Anomaly:**
   - 13 meters are assigned to `DT-007` (a 63 kVA transformer located in Sanganer, Jaipur).
   - Geographic coordinates of meters on `DT-007` span from Latitude `26.8027` in the south (meter `J100286`) to `27.0256` in the north (meter `J100326`), with `J100400` at `26.8827` — a **spread of more than 25 kilometers across Jaipur**.
   - In low-voltage distribution grids, secondary lines from a 63 kVA transformer typically extend no more than a few hundred meters. A 25 km spread is a severe GIS mapping error in the legacy dataset.
2. **Ampersands in Serials:**
   - 77 meters (manufactured by L&T) have serial numbers prefixed with `L&` (e.g. `L&84997`). Direct HTTP queries without URL encoding will fail or truncate.
3. **Strings for Numbers:**
   - Telemetry readings transmit numeric data as strings (`"48438.74"`).
4. **Missing Direct Feeder Codes on Meters:**
   - Meters only contain `dtCode`. Feeder associations must be reconstructed through Distribution Transformers.

---

## 4. Upstream Endpoint Mapping Table

| Wrapper Endpoint | Upstream Target(s) | Mechanism & Purpose |
|---|---|---|
| `GET /health` | *None* | Service health, uptime, and timestamp |
| `GET /api/v1/meters` | `GET /portal/export?page=1` (fallback: `GET /portal/meters/search`) | Fast HMAC bulk export with automatic pagination fallback; in-memory 5-minute TTL cache |
| `GET /api/v1/meters/:id` | `GET /meters/:id` (HTML) + `GET /portal/meters/:id/geo` (JSON) | Concurrent `Promise.all` fetch; Cheerio whitespace-tolerant HTML scraping + coordinate normalization |
| `GET /api/v1/meters/:id/energy` | `GET /portal/meters/:id/energy` | Safe numeric casting; ISO-8601 normalization with IST (+05:30) offset; supports `?limit=N` tail slice |
| `GET /api/v1/network/hierarchy` | `GET /portal/dts` + `GET /portal/meters/search` | Dynamic DT pagination; meters mapped to DTs via `dtCode`, and DTs mapped to feeders via `feederCode` |