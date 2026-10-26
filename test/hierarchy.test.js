const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { createUrjaClient, buildHierarchy, clearCache } = require('../services/urjaClient');
const app = require('../app');

describe('Electrical Network Hierarchy & Topology (Unit & Integration)', () => {
  let mockServer;
  let mockServerUrl;
  let appServer;
  let appServerUrl;
  let simulatedUpstreamError = false;

  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  let fixtureMeters = [];
  let fixtureDts = [];

  try {
    fixtureMeters = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'all-meters.json'), 'utf8'));
    fixtureDts = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'all-dts.json'), 'utf8'));
  } catch (err) {
    fixtureDts = [
      { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
      { code: 'DT-002', name: 'Mansarovar DT 2', feederCode: 'F-002', capacityKva: 63 }
    ];
    fixtureMeters = [
      { meterId: 'J100000', serialNo: 'SE33962', make: 'HPL', phaseType: 'single', installStatus: 'Decommissioned', dtCode: 'DT-001' },
      { meterId: 'J100001', serialNo: 'GE84132', make: 'L&T', phaseType: 'single', installStatus: 'Installed', dtCode: 'DT-002' }
    ];
  }

  before(async () => {
    await new Promise((resolve) => {
      mockServer = http.createServer((req, res) => {
        if (simulatedUpstreamError) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_server_error' }));
          return;
        }

        if (req.method === 'POST' && req.url === '/login') {
          res.writeHead(200, {
            'Set-Cookie': '__Secure-better-auth.session_token=mock_session; Path=/; HttpOnly',
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/portal/dts') {
          const page = parseInt(url.searchParams.get('page') || '1', 10);
          const pageSize = 20;
          const total = fixtureDts.length;
          const start = (page - 1) * pageSize;
          const pageData = fixtureDts.slice(start, start + pageSize);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            total,
            page,
            pageSize,
            data: pageData
          }));
          return;
        }

        if (url.pathname === '/portal/meters/search') {
          const page = parseInt(url.searchParams.get('page') || '1', 10);
          const pageSize = 20;
          const total = fixtureMeters.length;
          const start = (page - 1) * pageSize;
          const pageData = fixtureMeters.slice(start, start + pageSize);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            total,
            page,
            pageSize,
            data: pageData
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      mockServer.listen(0, () => {
        const port = mockServer.address().port;
        mockServerUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    await new Promise((resolve) => {
      appServer = http.createServer(app);
      appServer.listen(0, () => {
        const port = appServer.address().port;
        appServerUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    await new Promise((resolve) => appServer.close(resolve));
  });

  describe('fetchDTs() Dynamic Pagination', () => {
    it('dynamically paginates /portal/dts to retrieve all transformers', async () => {
      const client = createUrjaClient({ baseURL: mockServerUrl });
      const result = await client.fetchDTs();

      assert.equal(result.total, fixtureDts.length);
      assert.equal(result.data.length, fixtureDts.length);
      assert.ok(result.data.some(dt => dt.code === 'DT-001'));
      if (fixtureDts.length >= 40) {
        assert.ok(result.data.some(dt => dt.code === 'DT-040'));
      }
    });
  });

  describe('buildHierarchy() Pure Topological Assembly', () => {
    it('groups 3-tier hierarchy: Feeder -> Transformer -> Meters with accurate meter counts', () => {
      const hierarchy = buildHierarchy(fixtureDts, fixtureMeters);

      assert.ok(Array.isArray(hierarchy));
      assert.ok(hierarchy.length > 0);

      const sampleFeeder = hierarchy.find(f => f.feederCode === 'F-001');
      assert.ok(sampleFeeder, 'Feeder F-001 must exist');
      assert.ok(Array.isArray(sampleFeeder.transformers));

      const sampleDt = sampleFeeder.transformers.find(t => t.transformerCode === 'DT-001');
      assert.ok(sampleDt, 'DT-001 must be linked under feeder F-001');
      assert.equal(sampleDt.transformerCode, 'DT-001');
      assert.equal(sampleDt.name, 'Malviya Nagar DT 1');
      assert.equal(sampleDt.meterCount, sampleDt.meters.length);
    });

    it('guarantees 100% meter retention with zero duplicate or dropped meters across all leaves', () => {
      const hierarchy = buildHierarchy(fixtureDts, fixtureMeters);

      const leafMeterIds = [];
      let totalMeterCountSum = 0;

      for (const feeder of hierarchy) {
        for (const dt of feeder.transformers) {
          totalMeterCountSum += dt.meterCount;
          assert.equal(dt.meterCount, dt.meters.length, `meterCount must match meters.length for DT ${dt.transformerCode}`);
          for (const meter of dt.meters) {
            leafMeterIds.push(meter.meterId);
            assert.ok(meter.meterId, 'Meter in hierarchy must have meterId');
            assert.ok(meter.serialNo, 'Meter in hierarchy must have serialNo');
            assert.ok(meter.status, 'Meter in hierarchy must preserve status');
            assert.ok(meter.phase, 'Meter in hierarchy must preserve phase');
            assert.equal(meter.orphanDtCode, null);
          }
        }
      }

      assert.equal(totalMeterCountSum, fixtureMeters.length, 'Total meterCount across hierarchy must match source meters total');
      assert.equal(leafMeterIds.length, fixtureMeters.length, 'Total leaf meters must match source meters count');

      const uniqueMeterIds = new Set(leafMeterIds);
      assert.equal(uniqueMeterIds.size, fixtureMeters.length, 'Every meter must appear exactly once (no duplicates)');
    });

    it('defensively collects orphan meters (missing or unmapped dtCode) into UNASSIGNED bucket', () => {
      const testDts = [
        { code: 'DT-A', name: 'Alpha Transformer', feederCode: 'FEEDER-ALPHA', capacityKva: 100 }
      ];

      const testMeters = [
        { meterId: 'M-1', serialNo: 'SN001', make: 'L&T', phaseType: 'single', installStatus: 'Installed', dtCode: 'DT-A' },
        { meterId: 'M-ORPHAN-1', serialNo: 'SN002', make: 'Genus', phaseType: 'single', installStatus: 'Decommissioned', dtCode: null },
        { meterId: 'M-ORPHAN-2', serialNo: 'SN003', make: 'HPL', phaseType: 'three', installStatus: 'Installed', dtCode: '' },
        { meterId: 'M-ORPHAN-3', serialNo: 'SN004', make: 'Schneider', phaseType: 'single', installStatus: 'Decommissioned', dtCode: 'DT-NONEXISTENT' }
      ];

      const hierarchy = buildHierarchy(testDts, testMeters);

      const alphaFeeder = hierarchy.find(f => f.feederCode === 'FEEDER-ALPHA');
      assert.ok(alphaFeeder);
      assert.equal(alphaFeeder.transformers.length, 1);
      assert.equal(alphaFeeder.transformers[0].meters.length, 1);
      assert.equal(alphaFeeder.transformers[0].meters[0].meterId, 'M-1');

      const unassignedFeeder = hierarchy.find(f => f.feederCode === 'UNASSIGNED');
      assert.ok(unassignedFeeder, 'UNASSIGNED feeder branch must exist for orphan meters');
      assert.equal(unassignedFeeder.transformers.length, 1);

      const unassignedDt = unassignedFeeder.transformers[0];
      assert.equal(unassignedDt.transformerCode, 'UNASSIGNED');
      assert.equal(unassignedDt.capacityKva, 0);
      assert.equal(unassignedDt.meterCount, 3);
      assert.equal(unassignedDt.meters.length, 3);

      const orphanIds = unassignedDt.meters.map(m => m.meterId);
      assert.deepEqual(orphanIds.sort(), ['M-ORPHAN-1', 'M-ORPHAN-2', 'M-ORPHAN-3']);
      assert.equal(unassignedDt.meters.find(m => m.meterId === 'M-ORPHAN-3').orphanDtCode, 'DT-NONEXISTENT');
      assert.equal(unassignedDt.meters.find(m => m.meterId === 'M-ORPHAN-1').orphanDtCode, null);

      const allRetainedMeterIds = hierarchy
        .flatMap(f => f.transformers)
        .flatMap(t => t.meters)
        .map(m => m.meterId);
      assert.equal(allRetainedMeterIds.length, testMeters.length);
    });
  });

  describe('HTTP Route Integration (app.js)', () => {
    it('GET /api/v1/network/hierarchy returns 200 with complete hierarchy array', async () => {
      process.env.UPSTREAM_BASE_URL = mockServerUrl;
      const res = await fetch(`${appServerUrl}/api/v1/network/hierarchy`);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.ok(data.length > 0);
      assert.ok(data.some(f => f.feederCode === 'F-001'));
    });

    it('GET /api/v1/hierarchy and /hierarchy alias routes resolve identically', async () => {
      process.env.UPSTREAM_BASE_URL = mockServerUrl;
      const res1 = await fetch(`${appServerUrl}/api/v1/hierarchy`);
      assert.equal(res1.status, 200);
      const data1 = await res1.json();

      const res2 = await fetch(`${appServerUrl}/hierarchy`);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();

      assert.equal(data1.length, data2.length);
      assert.equal(data1[0].feederCode, data2[0].feederCode);
    });

    it('propagates upstream failures as 502 Bad Gateway with standard error envelope', async () => {
      clearCache();
      simulatedUpstreamError = true;
      try {
        const res = await fetch(`${appServerUrl}/api/v1/network/hierarchy`);
        assert.equal(res.status, 502);

        const data = await res.json();
        assert.equal(data.error, 'bad_gateway');
        assert.ok(data.message.includes('Failed to assemble network hierarchy'));
      } finally {
        simulatedUpstreamError = false;
        clearCache();
      }
    });
  });
});
