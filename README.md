# Flock Energy — Urja Meter Ops API Wrapper

A clean REST API service that wraps the legacy "Urja Meter Ops" utility portal and exposes its smart meter catalog, nameplate specifications, cumulative energy telemetry, and electrical distribution topology as structured JSON.

Built with **Node.js** and **Express**, using `axios` (with `tough-cookie` for session persistence) to interact with the legacy portal, and `cheerio` to parse server-rendered HTML nameplates.

---

## Contents
- [What this is](#what-this-is)
- [Project Architecture & File Layout](#project-architecture--file-layout)
- [Setup & Configuration](#setup--configuration)
- [Running the Service](#running-the-service)
- [API Endpoints & Usage](#api-endpoints--usage)
- [How It Works](#how-it-works)
- [Assumptions & Trade-offs](#assumptions--trade-offs)
- [What's Left Out](#whats-left-out)
- [PROTOCOL.md and openapi.json](#protocolmd-and-openapijson)
- [Note on AI Usage](#note-on-ai-usage)
- [Reflection](#reflection)

---

## What this is

Urja Meter Ops is an internal utility portal used by operations staff to inspect smart meters — nameplate specifications, geographic locations, and interval energy telemetry — by manually browsing a web application. It offers no public API.

This service sits in front of the portal, automates authentication and session maintenance, normalizes heterogeneous data, and exposes clean REST endpoints that external systems can consume reliably.

---

## Project Architecture & File Layout

```text
.
├── app.js                 # Express application, routes, input validation & Swagger UI setup
├── package.json           # Dependencies and scripts (Node >= 18 native test runner)
├── openapi.json           # OpenAPI 3.0 specification for this wrapper service
├── PROTOCOL.md            # Reverse-engineering documentation of the legacy portal
├── .env.example           # Environment variable template
├── services/
│   └── urjaClient.js      # Portal API client, session lifecycle, re-auth interceptor & caching
├── test/
│   ├── app.test.js        # Health check, CORS, 404 routing
│   ├── client.test.js     # Auth, session jar, interceptors
│   ├── meters.test.js     # Catalog pagination, filters, ampersand encoding
│   ├── meter-detail.test.js # Nameplate scraper, parallel geo synthesis
│   ├── energy.test.js     # Telemetry parsing, IST timestamps, tail limit
│   ├── hierarchy.test.js  # Network topology, orphan bucket, dynamic DTs
│   ├── cache.test.js      # In-memory TTL caching, mutex, HMAC export fallback
│   └── openapi.test.js    # OpenAPI 3.0 route parity & schema validation
└── fixtures/              # Recorded responses for offline testing & verification
    ├── all-meters.json
    ├── all-dts.json
    ├── energy-J100000.json
    ├── meter-J100000.html
    └── meter-J100004.html
```

---

## Setup & Configuration

**Prerequisites:** Node.js v18 or higher.

```bash
# Clone the repository
git clone https://github.com/GarvitSid/urja-assignment.git
cd urja-assignment

# Install dependencies
npm install
```

### Environment Configuration

Create a `.env` file in the project root:

```env
URJA_EMAIL=operator@urja.local
URJA_PASSWORD=urja-ops-2026
PORT=3000
```

An example template is also available in `.env.example`.

---

## Running the Service

```bash
# Start production server
npm start

# Or start in watch mode for development
npm run dev

# Run automated test suite
npm test
```

The service binds to `http://localhost:3000` (or the configured `PORT`).

---

## API Endpoints & Usage

Interactive documentation is hosted via Swagger UI at:
**`http://localhost:3000/docs`**

### 1. Health Check
```bash
curl http://localhost:3000/health
```
```json
{
  "status": "ok",
  "service": "urja-assignment",
  "uptime": 24.5,
  "timestamp": "2026-10-26T16:00:00.000Z"
}
```

### 2. List All Meters
Returns all 403 meters across the legacy portal. Results are cached in memory with a 5-minute TTL to reduce upstream latency on repeated calls.
```bash
# Fetch full list
curl http://localhost:3000/api/v1/meters

# Optional query parameters:
# Filter by ID / serial prefix: ?q=J100
# Filter by manufacturer make:  ?make=HPL
# Filter by status:            ?status=Installed
# Paginated results:           ?page=1&pageSize=20
# Force fresh upstream fetch:  ?fresh=true
curl "http://localhost:3000/api/v1/meters?make=HPL&status=Installed"
```

### 3. Get Single Meter Details
Fetches nameplate specifications from server-rendered HTML and coordinates from the client-side geo endpoint in parallel.
```bash
curl http://localhost:3000/api/v1/meters/J100001
```
```json
{
  "meterId": "J100001",
  "serialNo": "GE84132",
  "make": "L&T",
  "phaseType": "single",
  "installStatus": "Installed",
  "installType": "CT Operated",
  "location": {
    "latitude": 26.822136543835608,
    "longitude": 75.90718190602279
  }
}
```

### 4. Get Meter Energy Readings
Returns cumulative time-series telemetry. Timestamps are normalized from `"DD/MM/YYYY HH:mm"` to ISO-8601 with Indian Standard Time (`+05:30`) offset. Numeric strings are converted to numbers (`null` for empty/invalid values).
```bash
# Fetch all readings
curl http://localhost:3000/api/v1/meters/J100000/energy

# Limit to the most recent N readings (returns latest readings in chronological order):
curl "http://localhost:3000/api/v1/meters/J100000/energy?limit=10"
```
```json
[
  {
    "timestamp": "2026-06-23T23:30:00+05:30",
    "rawTimestamp": "23/06/2026 23:30",
    "kwh": 48438.74,
    "kvah": 52313.84,
    "voltR": 226
  }
]
```

### 5. Get Electrical Network Hierarchy
Reconstructs the 3-tier distribution topology (`Feeder -> Distribution Transformer -> Meters`) by joining the transformer inventory with the meter catalog.
```bash
curl http://localhost:3000/api/v1/network/hierarchy
```
```json
[
  {
    "feederCode": "F-001",
    "transformers": [
      {
        "transformerCode": "DT-001",
        "name": "Malviya Nagar DT 1",
        "capacityKva": 100,
        "meterCount": 12,
        "meters": [
          {
            "meterId": "J100000",
            "serialNo": "SE33962",
            "status": "Decommissioned",
            "phase": "single",
            "orphanDtCode": null
          }
        ]
      }
    ]
  }
]
```

---

## How It Works

- **Authentication & CSRF Compliance:**
  Login posts credentials as a SvelteKit form action (`POST /login` with `x-sveltekit-action: true`). The portal rejects requests without matching `Origin` and `Referer` headers with `403 Forbidden`. Successful authentication sets an HttpOnly `__Secure-better-auth.session_token` cookie, maintained in an Axios cookie jar.
- **Session Recovery Interceptor:**
  SvelteKit redirects expired sessions to `/login`, returning an `HTTP 200 OK` with an HTML login form. The Axios response interceptor detects this redirect (and HTTP 401 statuses), flags the session as expired, re-authenticates transparently, and replays the original request.
- **Fast Bulk Export & Fallback:**
  Inspection of the client-side Vite bundle (`_app/immutable/nodes/4.2Bgc2kUI.js`) uncovered an internal "Export all meters" action. It signs a newline-delimited canonical string (`[method, path, query, timestamp].join('\n')`) with HMAC-SHA256 using a signing secret from `GET /portal/keys`. This pulls all 403 meters in a single ~150 ms response. If the export endpoint is unavailable, the service automatically falls back to sequential pagination (`GET /portal/meters/search`).
- **In-Memory Caching:**
  The catalog list and transformer records are cached in memory for 5 minutes (`CACHE_TTL_MS`), eliminating the latency of crawling 21 pages on repeated calls.
- **HTML Scraping & Whitespace Tolerance:**
  Nameplate specifications in server-rendered HTML vary between records (e.g., `Serial No` vs `SerialNo`). The parser strips whitespace, colons, and casing dynamically with Cheerio.
- **Parallel Geo Synthesis:**
  GPS coordinates are omitted from the server-rendered HTML (which displays a "Loading location..." placeholder and loads coordinates client-side). The wrapper queries the HTML and `/portal/meters/:id/geo` concurrently using `Promise.all`.
- **Network Hierarchy Reconstruction:**
  Meters carry `dtCode` but lack `feederCode`. The service queries `/portal/dts` to build a transformer-to-feeder mapping and joins meters in memory, preserving unassigned meters under an `UNASSIGNED` branch.

---

## Assumptions & Trade-offs

1. **Cheerio SSR Scraping vs `devalue` Deserialization:**
   The portal exposes `GET /meters/{id}/__data.json` returning SvelteKit's index-referenced `devalue` format. Scraping the HTML `<dt>`/`<dd>` elements with Cheerio was chosen because the semantic HTML document structure is more stable than SvelteKit's private index pointers, which can shift between framework updates.
2. **Endpoint Naming (`/energy`):**
   The upstream portal names its endpoint `/portal/meters/:id/energy` and the values represent cumulative dial registers rather than interval deltas. The route is named `/energy` to align directly with the underlying telemetry semantics.
3. **Catalog Schema Normalization:**
   The bulk export endpoint (`/portal/export`) includes extra backend fields (such as a 7-tier geographic hierarchy and coordinates). However, the standard search endpoint (`/portal/meters/search`) only provides meter identity and status fields. The meter catalog schema is normalized across both retrieval strategies so that `/api/v1/meters` returns consistent data regardless of whether the bulk export or paginated fallback was used.
4. **Timezone Handling:**
   Upstream timestamps are `"DD/MM/YYYY HH:mm"`. Since the data belongs to Jaipur DISCOM in Rajasthan, timestamps represent Indian Standard Time (IST, UTC+05:30). They are parsed with the `+05:30` offset while preserving `rawTimestamp`.
5. **Feeder Association:**
   Meters do not carry `feederCode` directly; they only carry `dtCode`. Feeder codes exist on Distribution Transformers (`/portal/dts`). The topology is structured as `Feeder -> DT -> Meter`.

---

## What's Left Out

- **Distributed Cache (Redis):** The current cache is in-memory within the Node.js process. In a horizontally scaled deployment with multiple replicas, an external cache would be needed.
- **Persistent Database:** The service operates as a stateless proxy.
- **Downstream Rate Limiting:** While the proxy implements in-memory caching to protect the upstream server, it does not currently enforce rate limiting on incoming API clients.

---

## PROTOCOL.md and openapi.json

- **[PROTOCOL.md](./PROTOCOL.md):** In-depth reverse-engineering documentation covering SvelteKit authentication mechanics, client bundle extraction, HMAC signing algorithms, and data anomalies (such as the 25 km geographic scatter on `DT-007`).
- **[openapi.json](./openapi.json):** OpenAPI 3.0 specification covering all endpoints, query parameters, schemas, and error responses.

---

## Note on AI Usage

I used an AI assistant during development to accelerate initial boilerplate code, test scaffolding, and documentation drafts. All architectural decisions, portal reverse-engineering (including DevTools inspection, bundle extraction for the HMAC export algorithm, and anomaly analysis on `DT-007`), and protocol verification were tested and validated against the live portal.

---

## Reflection

### 1. What assumptions did you make?
I assumed the credentials provided had read-only access, making it safe to paginate through the catalog. I also assumed the nameplate HTML structure (`<dt>`/`<dd>` pairs) was stable enough to scrape; while we normalized whitespace and casing, a full markup overhaul would require scraper updates. Analysis of the energy telemetry showed strictly monotonically increasing `kwh` values, confirming the assumption that values are cumulative meter dial registers rather than interval deltas.

### 2. Which part was most difficult, and how did you get unstuck?
Discovering how to access meter coordinates and the bulk export route. The SSR HTML for a meter showed only a "Loading location..." placeholder badge without coordinates. Inspecting the browser Network tab revealed that the frontend component mounts and makes a secondary call to `GET /portal/meters/{id}/geo`. Later, examining the client-side Vite bundle chunk `_app/immutable/nodes/4.2Bgc2kUI.js` revealed the "Export all meters" action, the `/portal/keys` signing secret, and the newline-delimited canonical string construction (`[method, path, query, timestamp].join('\n')`), enabling single-request bulk export.

### 3. What mistake did you make?
My initial login attempts from code failed with `403 Forbidden` because SvelteKit rejects requests without `Origin` and `Referer` headers matching the portal host. I also initially got `null` for coordinates because I missed that the `/geo` response nests the data an extra level (`response.data.data.latitude`, not `response.data.latitude`). Additionally, my first version of the session interceptor detected redirects to `/login` but still returned the login HTML to the caller. I corrected this by having the interceptor re-authenticate and replay the original request.

### 4. If you had another day, what would you improve?
1. **Redis Caching:** Replace the local process cache with Redis to support multi-instance horizontal scaling.
2. **Anomaly Reporting Endpoint:** Expose a dedicated diagnostic endpoint (e.g., `/api/v1/diagnostics/anomalies`) highlighting records with data quality issues, such as meters on `DT-007` whose coordinates span across a 25 km radius.
3. **Downstream Rate Limiting:** Add token-bucket rate limiting to prevent downstream clients from overwhelming the proxy.

### 5. If you were reviewing your own submission, what would you criticize?
1. **Coupling to DOM Markup:** While whitespace and casing are stripped dynamically, scraping HTML is inherently more fragile than consuming a typed API. If the portal redesigns the nameplate view from `<dl>` to a different component structure, `getMeterDetails` will require maintenance.
2. **In-Memory Cache Coherence:** The in-memory cache is local to the Node.js process. If deployed across multiple worker processes or containers, caches could temporarily drift until the 5-minute TTL expires.
