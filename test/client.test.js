const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUrjaClient } = require('../services/urjaClient');

describe('Urja Portal Client - Authentication & Self-Healing Interceptor', () => {
  let server;
  let serverUrl;
  let loginCount = 0;
  let dataRequestCount = 0;
  let simulatedScenario = 'normal';

  before(() => {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        // Mock SvelteKit login action
        if (req.method === 'POST' && req.url === '/login') {
          loginCount++;
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            // Verify mandatory SvelteKit headers
            const svelteHeader = req.headers['x-sveltekit-action'];
            const originHeader = req.headers['origin'];
            const refererHeader = req.headers['referer'];

            if (svelteHeader !== 'true' || !originHeader || !refererHeader) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing required SvelteKit headers' }));
              return;
            }

            res.writeHead(200, {
              'Set-Cookie': '__Secure-better-auth.session_token=valid_session_12345; Path=/; HttpOnly',
              'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({ type: 'success', status: 200 }));
          });
          return;
        }

        // Mock protected data endpoint
        if (req.method === 'GET' && req.url === '/portal/data') {
          dataRequestCount++;
          const cookieHeader = req.headers['cookie'] || '';

          // Scenario 1: Expired session returns 401 on first try, then succeeds after re-auth
          if (simulatedScenario === '401-recovery') {
            if (!cookieHeader.includes('valid_session_12345')) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'unauthorized', message: 'Session expired' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: dataRequestCount }));
            return;
          }

          // Scenario 2: Silent redirect to login page (HTTP 200 with HTML)
          if (simulatedScenario === 'login-redirect-recovery') {
            if (!cookieHeader.includes('valid_session_12345')) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><form action="/login" method="POST"><input name="password"/></form></html>');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: dataRequestCount }));
            return;
          }

          // Scenario 3: CSRF error returning 403 Forbidden
          if (simulatedScenario === '403-forbidden') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden', message: 'CSRF token mismatch' }));
            return;
          }

          // Scenario 4: Persistent failure (should not loop)
          if (simulatedScenario === 'persistent-401') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid credentials' }));
            return;
          }

          // Default success
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      server.listen(0, () => {
        const port = server.address().port;
        serverUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(() => {
    return new Promise((resolve) => server.close(resolve));
  });

  it('authenticate() successfully logs in with required SvelteKit headers and stores cookie', async () => {
    loginCount = 0;
    const { authenticate, jar, baseURL } = createUrjaClient({ baseURL: serverUrl });
    const response = await authenticate();

    assert.equal(response.status, 200);
    assert.equal(loginCount, 1);

    const cookies = await jar.getCookies(baseURL);
    const sessionCookie = cookies.find(c => c.key === '__Secure-better-auth.session_token');
    assert.ok(sessionCookie, 'Session cookie must be stored in the cookie jar');
    assert.equal(sessionCookie.value, 'valid_session_12345');
  });

  it('automatically re-authenticates and replays request on HTTP 401', async () => {
    loginCount = 0;
    dataRequestCount = 0;
    simulatedScenario = '401-recovery';

    const { client } = createUrjaClient({ baseURL: serverUrl });
    const response = await client.get('/portal/data');

    assert.equal(response.status, 200);
    assert.equal(response.data.success, true);
    assert.equal(loginCount, 1, 'Should trigger exactly one re-authentication');
    assert.equal(dataRequestCount, 2, 'Should make initial request + 1 replayed request');
  });

  it('automatically re-authenticates and replays request on HTML login redirect (HTTP 200)', async () => {
    loginCount = 0;
    dataRequestCount = 0;
    simulatedScenario = 'login-redirect-recovery';

    const { client } = createUrjaClient({ baseURL: serverUrl });
    const response = await client.get('/portal/data');

    assert.equal(response.status, 200);
    assert.equal(response.data.success, true);
    assert.equal(loginCount, 1, 'Should trigger exactly one re-authentication');
    assert.equal(dataRequestCount, 2, 'Should replay original request after re-authentication');
  });

  it('does NOT retry or re-authenticate on HTTP 403 Forbidden', async () => {
    loginCount = 0;
    simulatedScenario = '403-forbidden';

    const { client } = createUrjaClient({ baseURL: serverUrl });

    await assert.rejects(
      async () => { await client.get('/portal/data'); },
      (err) => {
        assert.equal(err.response?.status, 403);
        assert.equal(loginCount, 0, 'Must NOT attempt re-authentication on 403');
        return true;
      }
    );
  });

  it('retries at most once and does not enter infinite loop on persistent 401', async () => {
    loginCount = 0;
    dataRequestCount = 0;
    simulatedScenario = 'persistent-401';

    const { client } = createUrjaClient({ baseURL: serverUrl });

    await assert.rejects(
      async () => { await client.get('/portal/data'); },
      (err) => {
        assert.equal(err.response?.status, 401);
        assert.equal(loginCount, 1, 'Should attempt re-authentication once');
        assert.equal(dataRequestCount, 2, 'Should attempt original request plus one retry');
        return true;
      }
    );
  });

  it('serializes concurrent login requests using mutex lock', async () => {
    loginCount = 0;
    const { authenticate } = createUrjaClient({ baseURL: serverUrl });

    // Launch 5 simultaneous authenticate() calls
    const results = await Promise.all([
      authenticate(),
      authenticate(),
      authenticate(),
      authenticate(),
      authenticate()
    ]);

    assert.equal(results.length, 5);
    assert.equal(loginCount, 1, 'Concurrency mutex must ensure exactly 1 login HTTP request');
  });
});
