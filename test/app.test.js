const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');

describe('Service Foundation - Health Check & 404 Routing', () => {
  let server;
  let baseUrl;

  before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(() => {
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('GET /health returns 200 with status ok and ISO timestamp', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.timestamp, 'timestamp should be present');
    assert.ok(!isNaN(Date.parse(body.timestamp)), 'timestamp should be a valid ISO date');
  });

  it('GET /unknown-route returns 404 with JSON error envelope', async () => {
    const res = await fetch(`${baseUrl}/api/v1/unknown-endpoint`);
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.error, 'not_found');
    assert.equal(body.message, 'Cannot GET /api/v1/unknown-endpoint');
  });

  it('CORS preflight OPTIONS returns 200 OK', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'OPTIONS' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});
