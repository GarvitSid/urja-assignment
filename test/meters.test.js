const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUrjaClient } = require('../services/urjaClient');

describe('Meter Catalog & Dynamic Pagination (Services)', () => {
  let server;
  let serverUrl;
  let requestedUrls = [];

  const mockFleet = Array.from({ length: 45 }, (_, i) => ({
    meterId: `J1000${String(i).padStart(2, '0')}`,
    serialNo: i % 2 === 0 ? `L&${10000 + i}` : `GE${20000 + i}`,
    make: i % 2 === 0 ? 'L&T' : 'Genus',
    phaseType: i % 3 === 0 ? 'three' : 'single',
    installStatus: i % 5 === 0 ? 'Faulty' : 'Installed',
    dtCode: `DT-00${(i % 5) + 1}`
  }));

  before(() => {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        requestedUrls.push(req.url);

        if (req.method === 'POST' && req.url === '/login') {
          res.writeHead(200, {
            'Set-Cookie': '__Secure-better-auth.session_token=test_token; Path=/; HttpOnly',
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (req.url.startsWith('/portal/meters/search')) {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const q = parsedUrl.searchParams.get('q') || '';
          const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
          const pageSize = 20;

          let matched = mockFleet;
          if (q) {
            matched = mockFleet.filter(m => m.meterId.includes(q) || m.serialNo.includes(q));
          }

          const start = (page - 1) * pageSize;
          const pageData = matched.slice(start, start + pageSize);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            total: matched.length,
            page,
            pageSize,
            data: pageData
          }));
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

  it('fetchMeters() dynamically calculates total pages and retrieves complete collection', async () => {
    requestedUrls = [];
    const { fetchMeters } = createUrjaClient({ baseURL: serverUrl });
    const result = await fetchMeters();

    assert.equal(result.total, 45);
    assert.equal(result.data.length, 45);

    const page1Req = requestedUrls.find(u => u.includes('page=1'));
    const page2Req = requestedUrls.find(u => u.includes('page=2'));
    const page3Req = requestedUrls.find(u => u.includes('page=3'));
    assert.ok(page1Req, 'Page 1 must be requested');
    assert.ok(page2Req, 'Page 2 must be requested dynamically');
    assert.ok(page3Req, 'Page 3 must be requested dynamically');
  });

  it('URL-encodes serial numbers containing ampersands (L& serials)', async () => {
    requestedUrls = [];
    const { fetchMeters } = createUrjaClient({ baseURL: serverUrl });
    const result = await fetchMeters({ q: 'L&10000' });

    assert.equal(result.total, 1);
    assert.equal(result.data[0].serialNo, 'L&10000');

    const searchUrl = requestedUrls.find(u => u.startsWith('/portal/meters/search'));
    assert.ok(searchUrl.includes('q=L%2610000'), 'Query parameter must be URL-encoded with %26');
  });

  it('safely coerces repeated array queries (?q=a&q=b) to string', async () => {
    const { fetchMeters } = createUrjaClient({ baseURL: serverUrl });
    const result = await fetchMeters({ q: ['J100000', 'J100001'] });

    assert.equal(result.total, 1);
    assert.equal(result.data[0].meterId, 'J100000');
  });

  it('applies client-side filtering for make and installStatus', async () => {
    const { fetchMeters } = createUrjaClient({ baseURL: serverUrl });

    const genusMeters = await fetchMeters({ make: 'genus' });
    assert.ok(genusMeters.total > 0);
    assert.ok(genusMeters.data.every(m => m.make.toLowerCase() === 'genus'));

    const faultyMeters = await fetchMeters({ status: 'faulty' });
    assert.ok(faultyMeters.total > 0);
    assert.ok(faultyMeters.data.every(m => m.installStatus === 'Faulty'));

    const combined = await fetchMeters({ make: 'L&T', status: 'Faulty' });
    assert.ok(combined.data.every(m => m.make === 'L&T' && m.installStatus === 'Faulty'));
  });

  it('GET /api/v1/meters route returns 200 with data array and supports pagination slicing', async () => {
    process.env.UPSTREAM_BASE_URL = serverUrl;
    const app = require('../app');
    const expressServer = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = expressServer.address().port;
    const appBaseUrl = `http://localhost:${port}`;

    try {
      const fullRes = await fetch(`${appBaseUrl}/api/v1/meters`);
      assert.equal(fullRes.status, 200);
      const fullData = await fullRes.json();
      assert.ok(Array.isArray(fullData));
      assert.ok(fullData.length >= 40, `Expected fleet >= 40, got ${fullData.length}`);

      const paginatedRes = await fetch(`${appBaseUrl}/api/v1/meters?page=2&pageSize=10`);
      assert.equal(paginatedRes.status, 200);
      const paginatedData = await paginatedRes.json();
      assert.ok(paginatedData.total >= 40);
      assert.equal(paginatedData.page, 2);
      assert.equal(paginatedData.pageSize, 10);
      assert.equal(paginatedData.data.length, 10);
      assert.ok(paginatedData.data[0].meterId, 'Meter item must have meterId');
    } finally {
      await new Promise(resolve => expressServer.close(resolve));
    }
  });
});
