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


