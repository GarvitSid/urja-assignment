const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUrjaClient, parseNameplateHtml } = require('../services/urjaClient');

describe('Meter Detail & Nameplate Scraping (Unit & Integration)', () => {
  let server;
  let serverUrl;
  let simulatedGeoStatus = 200;
  let simulatedHtmlStatus = 200;

  const sampleSpacedHtml = `
    <html>
      <body>
        <dl>
          <div>
            <dt>Meter ID</dt>
            <dd>J100000</dd>
          </div>
          <div>
            <dt>Serial No</dt>
            <dd>SE33962</dd>
          </div>
          <div>
            <dt>Make</dt>
            <dd>HPL</dd>
          </div>
          <div>
            <dt>Phase Type</dt>
            <dd>single</dd>
          </div>
          <div>
            <dt>Installation Status</dt>
            <dd>Decommissioned</dd>
          </div>
          <div>
            <dt>Installation Type</dt>
            <dd>Whole Current</dd>
          </div>
        </dl>
      </body>
    </html>
  `;

  const sampleConcatenatedHtml = `
    <html>
      <body>
        <dl>
          <div>
            <dt>MeterId</dt>
            <dd>J100004</dd>
          </div>
          <div>
            <dt>SerialNo</dt>
            <dd>SE65293</dd>
          </div>
          <div>
            <dt>Make</dt>
            <dd>Genus</dd>
          </div>
          <div>
            <dt>PhaseType</dt>
            <dd>single</dd>
          </div>
          <div>
            <dt>InstallationStatus</dt>
            <dd>Faulty</dd>
          </div>
          <div>
            <dt>InstallationType</dt>
            <dd>CT Operated</dd>
          </div>
        </dl>
      </body>
    </html>
  `;

  before(() => {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/login') {
          res.writeHead(200, {
            'Set-Cookie': '__Secure-better-auth.session_token=test_token; Path=/; HttpOnly',
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (req.url.startsWith('/meters/')) {
          if (simulatedHtmlStatus === 404) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<html><body>404 Not Found</body></html>');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(sampleSpacedHtml);
          return;
        }

        if (req.url.includes('/geo')) {
          if (simulatedGeoStatus === 404) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            return;
          }
          if (simulatedGeoStatus === 500) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'server_error' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: { latitude: 26.8221, longitude: 75.9071 }
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

  it('parseNameplateHtml extracts and normalizes spaced label cards (J100000 format)', () => {
    const parsed = parseNameplateHtml(sampleSpacedHtml);
    assert.equal(parsed.meterId, 'J100000');
    assert.equal(parsed.serialNo, 'SE33962');
    assert.equal(parsed.make, 'HPL');
    assert.equal(parsed.phaseType, 'single');
    assert.equal(parsed.installStatus, 'Decommissioned');
    assert.equal(parsed.installType, 'Whole Current');
  });

  it('parseNameplateHtml extracts and normalizes concatenated label cards (J100004 format)', () => {
    const parsed = parseNameplateHtml(sampleConcatenatedHtml);
    assert.equal(parsed.meterId, 'J100004');
    assert.equal(parsed.serialNo, 'SE65293');
    assert.equal(parsed.make, 'Genus');
    assert.equal(parsed.phaseType, 'single');
    assert.equal(parsed.installStatus, 'Faulty');
    assert.equal(parsed.installType, 'CT Operated');
  });

  it('parseNameplateHtml handles empty dd tags gracefully', () => {
    const emptyHtml = '<dl><div><dt>Meter ID</dt><dd></dd></div></dl>';
    const parsed = parseNameplateHtml(emptyHtml);
    assert.equal(parsed.meterId, '');
  });

  it('getMeterDetail fetches HTML nameplate and merges geo coordinates in parallel', async () => {
    simulatedHtmlStatus = 200;
    simulatedGeoStatus = 200;

    const { getMeterDetail } = createUrjaClient({ baseURL: serverUrl });
    const detail = await getMeterDetail('J100000');

    assert.equal(detail.meterId, 'J100000');
    assert.equal(detail.serialNo, 'SE33962');
    assert.ok(detail.location);
    assert.equal(detail.location.latitude, 26.8221);
    assert.equal(detail.location.longitude, 75.9071);
  });

  it('getMeterDetail gracefully sets location to null when geo returns 404', async () => {
    simulatedHtmlStatus = 200;
    simulatedGeoStatus = 404;

    const { getMeterDetail } = createUrjaClient({ baseURL: serverUrl });
    const detail = await getMeterDetail('J100000');

    assert.equal(detail.meterId, 'J100000');
    assert.equal(detail.location, null);
  });

  it('getMeterDetail logs and sets location to null when geo returns 500 without crashing', async () => {
    simulatedHtmlStatus = 200;
    simulatedGeoStatus = 500;

    const { getMeterDetail } = createUrjaClient({ baseURL: serverUrl });
    const detail = await getMeterDetail('J100000');

    assert.equal(detail.meterId, 'J100000');
    assert.equal(detail.location, null);
  });

  it('getMeterDetail throws 404 error when upstream HTML page returns 404', async () => {
    simulatedHtmlStatus = 404;

    const { getMeterDetail } = createUrjaClient({ baseURL: serverUrl });
    await assert.rejects(
      async () => { await getMeterDetail('J999999'); },
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, 'not_found');
        return true;
      }
    );
  });

  it('GET /api/v1/meters/:id route rejects invalid meter ID formats with HTTP 400', async () => {
    const app = require('../app');
    const expressServer = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = expressServer.address().port;
    const appBaseUrl = `http://localhost:${port}`;

    try {
      const res = await fetch(`${appBaseUrl}/api/v1/meters/INVALID!@#$`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'bad_request');
      assert.ok(body.message.includes('Invalid meter ID format'));
    } finally {
      await new Promise(resolve => expressServer.close(resolve));
    }
  });
});
