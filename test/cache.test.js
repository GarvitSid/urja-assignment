const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('crypto');
const { createUrjaClient } = require('../services/urjaClient');

describe('In-Memory TTL Cache & Reverse-Engineered HMAC Export (Unit & Integration)', () => {
  let mockServer;
  let mockServerUrl;

  const mockSecret = 'test_secret_key_884920';
  let exportHits = 0;
  let keysHits = 0;
  let searchHits = 0;
  let failExport = false;

  const mockBulkMeters = Array.from({ length: 25 }, (_, i) => ({
    meterId: `J1000${String(i).padStart(2, '0')}`,
    serialNo: `SN-${1000 + i}`,
    make: i % 2 === 0 ? 'HPL' : 'Genus',
    phaseType: 'single',
    installStatus: 'Installed',
    dtCode: `DT-00${(i % 3) + 1}`,
    hierarchy: { zone: { code: 'Z-01' } },
    geo: { lat: 26.9, lng: 75.8 }
  }));

  before(async () => {
    await new Promise((resolve) => {
      mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/login') {
          res.writeHead(200, {
            'Set-Cookie': '__Secure-better-auth.session_token=mock_session; Path=/; HttpOnly',
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/portal/keys') {
          keysHits++;
          if (failExport) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error', message: 'Keys endpoint offline' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { signingSecret: mockSecret } }));
          return;
        }

        if (url.pathname === '/portal/export') {
          exportHits++;
          if (failExport) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
            return;
          }

          const timestamp = req.headers['x-timestamp'];
          const signature = req.headers['x-signature'];

          if (!timestamp || !signature) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing_hmac_headers' }));
            return;
          }

          const query = url.search.replace(/^\?/, '');
          const canonical = [req.method, url.pathname, query, timestamp].join('\n');
          const expectedSig = crypto.createHmac('sha256', mockSecret).update(canonical).digest('hex');

          if (signature !== expectedSig) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_signature' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            total: mockBulkMeters.length,
            data: mockBulkMeters
          }));
          return;
        }

        if (url.pathname === '/portal/meters/search') {
          searchHits++;
          const page = parseInt(url.searchParams.get('page') || '1', 10);
          const pageSize = 20;
          const start = (page - 1) * pageSize;
          const pageData = mockBulkMeters.slice(start, start + pageSize);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            total: mockBulkMeters.length,
            page,
            pageSize,
            data: pageData
          }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      mockServer.listen(0, () => {
        const port = mockServer.address().port;
        mockServerUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
  });

  describe('computeHmacSignature() Helper', () => {
    it('computes exact SHA-256 HMAC signature from canonical newline string', () => {
      const client = createUrjaClient();
      const secret = 'my_secret_key';
      const timestamp = '1719788400';
      const canonical = ['GET', '/portal/export', 'page=1', timestamp].join('\n');
      const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

      const signature1 = client.computeHmacSignature(secret, 'GET', '/portal/export', 'page=1', timestamp);
      assert.equal(signature1, expected);

      const signature2 = client.computeHmacSignature(secret, canonical);
      assert.equal(signature2, expected);
    });
  });

  describe('Fast Bulk Export with HMAC Signing', () => {
    it('fetches signing secret from /portal/keys and successfully downloads bulk meters', async () => {
      const client = createUrjaClient({ baseURL: mockServerUrl });
      const result = await client.fetchExportMeters();

      assert.equal(result.total, mockBulkMeters.length);
      assert.equal(result.data.length, mockBulkMeters.length);
      assert.equal(result.data[0].meterId, 'J100000');
      assert.equal(result.data[0].serialNo, 'SN-1000');
      assert.ok(result.data[0].make);
      assert.ok(result.data[0].phaseType);
      assert.ok(result.data[0].installStatus);
      assert.ok(result.data[0].dtCode);
      assert.equal(result.data[0].hierarchy, undefined);
    });
  });

  describe('In-Memory TTL Cache', () => {
    it('caches fleet responses and prevents redundant upstream requests within TTL', async () => {
      const client = createUrjaClient({ baseURL: mockServerUrl });
      client.clearCache();

      const initialExportHits = exportHits;
      const firstResult = await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 1);

      const secondResult = await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 1);
      assert.deepEqual(secondResult, firstResult);

      client.clearCache();
      await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 2);
    });

    it('bypasses cache when forceRefresh option is provided', async () => {
      const client = createUrjaClient({ baseURL: mockServerUrl });
      client.clearCache();

      const initialExportHits = exportHits;
      await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 1);

      await client.fetchMetersWithFallback({ forceRefresh: true });
      assert.equal(exportHits, initialExportHits + 2);
    });

    it('expires cache after configured TTL duration', async () => {
      const shortTtlMs = 50;
      const client = createUrjaClient({ baseURL: mockServerUrl, cacheTtlMs: shortTtlMs });
      client.clearCache();

      const initialExportHits = exportHits;
      await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 1);

      await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 1);

      await new Promise((resolve) => setTimeout(resolve, shortTtlMs + 20));

      await client.fetchMetersWithFallback();
      assert.equal(exportHits, initialExportHits + 2);
    });
  });

  describe('Single-Flight Promise Mutex (Thundering Herd Protection)', () => {
    it('deduplicates concurrent requests into a single upstream call', async () => {
      const client = createUrjaClient({ baseURL: mockServerUrl });
      client.clearCache();

      const initialExportHits = exportHits;

      const results = await Promise.all([
        client.fetchMetersWithFallback(),
        client.fetchMetersWithFallback(),
        client.fetchMetersWithFallback(),
        client.fetchMetersWithFallback(),
        client.fetchMetersWithFallback()
      ]);

      assert.equal(results.length, 5);
      for (const res of results) {
        assert.equal(res.total, mockBulkMeters.length);
      }

      assert.equal(exportHits, initialExportHits + 1);
    });
  });

  describe('Graceful Fallback to Paginated Search', () => {
    it('falls back to /portal/meters/search pagination when export endpoint fails', async () => {
      const client = createUrjaClient({ baseURL: mockServerUrl });
      client.clearCache();

      failExport = true;
      const initialSearchHits = searchHits;

      try {
        const result = await client.fetchMetersWithFallback();
        assert.ok(result);
        assert.equal(result.total, mockBulkMeters.length);
        assert.ok(searchHits > initialSearchHits, 'Must have traversed paginated search endpoint');
      } finally {
        failExport = false;
      }
    });
  });
});
