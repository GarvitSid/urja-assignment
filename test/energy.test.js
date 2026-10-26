const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUrjaClient, normalizeNumber, parseToISO } = require('../services/urjaClient');

describe('Energy Telemetry Normalization & Validation (Unit & Integration)', () => {
  let server;
  let serverUrl;
  let simulatedEnergyStatus = 200;

  const mockReadings = [
    { timestamp: '28/06/2026 12:00', kwh: '48438.74', kvah: '52313.84', voltR: '230' },
    { timestamp: '29/06/2026 12:00', kwh: '48439.16', kvah: '52314.12', voltR: '232' },
    { timestamp: '30/06/2026 12:00', kwh: '48439.58', kvah: '52314.50', voltR: '231' },
    { timestamp: '30/06/2026 18:00', kwh: '', kvah: null, voltR: 'Infinity' }, // Sensor dropout edge-case
    { timestamp: '30/06/2026 23:00', kwh: '48580.36', kvah: '52466.79', voltR: '230' }
  ];

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

        if (req.url.includes('/energy')) {
          if (simulatedEnergyStatus === 404) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found', message: 'Meter not found' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: mockReadings }));
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

  describe('normalizeNumber Helper', () => {
    it('converts valid numeric strings and numbers correctly', () => {
      assert.equal(normalizeNumber('48438.74'), 48438.74);
      assert.equal(normalizeNumber(230), 230);
      assert.equal(normalizeNumber('0'), 0);
      assert.equal(normalizeNumber(0), 0);
    });

    it('safely converts empty strings, whitespace, null, and undefined to null (not 0)', () => {
      assert.equal(normalizeNumber(''), null, 'Empty string must NOT coerce to 0');
      assert.equal(normalizeNumber('   '), null);
      assert.equal(normalizeNumber(null), null);
      assert.equal(normalizeNumber(undefined), null);
    });

    it('converts non-numeric and non-finite values to null', () => {
      assert.equal(normalizeNumber('Infinity'), null);
      assert.equal(normalizeNumber(Infinity), null);
      assert.equal(normalizeNumber(-Infinity), null);
      assert.equal(normalizeNumber('NaN'), null);
      assert.equal(normalizeNumber('invalid_sensor'), null);
    });
  });

  describe('parseToISO Helper', () => {
    it('converts DD/MM/YYYY HH:mm to ISO-8601 with explicit IST (+05:30) offset', () => {
      const iso = parseToISO('30/06/2026 23:00');
      assert.equal(iso, '2026-06-30T23:00:00+05:30');
      assert.ok(!isNaN(Date.parse(iso)), 'Must be parseable as valid date');
    });

    it('handles day > 12 verifying day-first parsing', () => {
      const iso = parseToISO('17/06/2026 00:00');
      assert.equal(iso, '2026-06-17T00:00:00+05:30');
    });

    it('returns null for null, undefined, or malformed date inputs', () => {
      assert.equal(parseToISO(null), null);
      assert.equal(parseToISO(''), null);
      assert.equal(parseToISO('not-a-date'), null);
    });
  });

  describe('getMeterEnergy Service', () => {
    it('unwraps response and normalizes all fields while preserving rawTimestamp', async () => {
      simulatedEnergyStatus = 200;
      const { getMeterEnergy } = createUrjaClient({ baseURL: serverUrl });
      const readings = await getMeterEnergy('J100000');

      assert.equal(readings.length, 5);
      assert.equal(readings[0].timestamp, '2026-06-28T12:00:00+05:30');
      assert.equal(readings[0].rawTimestamp, '28/06/2026 12:00');
      assert.equal(readings[0].kwh, 48438.74);

      assert.equal(readings[3].kwh, null);
      assert.equal(readings[3].kvah, null);
      assert.equal(readings[3].voltR, null);
    });

    it('slices the chronological tail when limit is passed and maintains chronological order', async () => {
      simulatedEnergyStatus = 200;
      const { getMeterEnergy } = createUrjaClient({ baseURL: serverUrl });
      const readings = await getMeterEnergy('J100000', 2);

      assert.equal(readings.length, 2);
      assert.equal(readings[0].rawTimestamp, '30/06/2026 18:00');
      assert.equal(readings[1].rawTimestamp, '30/06/2026 23:00');
      assert.equal(readings[1].kwh, 48580.36);
    });

    it('propagates upstream 404 as a not_found error', async () => {
      simulatedEnergyStatus = 404;
      const { getMeterEnergy } = createUrjaClient({ baseURL: serverUrl });

      await assert.rejects(
        async () => { await getMeterEnergy('J999999'); },
        (err) => {
          assert.equal(err.status, 404);
          assert.equal(err.code, 'not_found');
          return true;
        }
      );
    });
  });

  describe('HTTP Route Integration (app.js)', () => {
    it('GET /api/v1/meters/:id/energy rejects non-positive or non-integer limits with 400', async () => {
      const app = require('../app');
      const expressServer = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = expressServer.address().port;
      const appBaseUrl = `http://localhost:${port}`;

      try {
        const res1 = await fetch(`${appBaseUrl}/api/v1/meters/J100000/energy?limit=invalid`);
        assert.equal(res1.status, 400);
        const body1 = await res1.json();
        assert.equal(body1.error, 'bad_request');

        const res2 = await fetch(`${appBaseUrl}/api/v1/meters/J100000/energy?limit=0`);
        assert.equal(res2.status, 400);

        const res3 = await fetch(`${appBaseUrl}/api/v1/meters/J100000/energy?limit=-5`);
        assert.equal(res3.status, 400);

        const res4 = await fetch(`${appBaseUrl}/api/v1/meters/J100000/energy?limit=2.5`);
        assert.equal(res4.status, 400);
      } finally {
        await new Promise(resolve => expressServer.close(resolve));
      }
    });
  });
});
