const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('../app');

describe('OpenAPI Specification & Swagger UI Integration', () => {
  let server;
  let baseUrl;
  let openapi;

  before(() => {
    const openapiRaw = fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8');
    openapi = JSON.parse(openapiRaw);

    return new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(() => {
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  describe('Interactive Documentation Endpoints', () => {
    it('GET / redirects to /docs with HTTP 302', async () => {
      const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/docs');
    });

    it('GET /docs/ serves Swagger UI HTML bundle with HTTP 200', async () => {
      const res = await fetch(`${baseUrl}/docs/`);
      assert.equal(res.status, 200);
      const contentType = res.headers.get('content-type');
      assert.ok(contentType.includes('text/html'), 'Content-Type should be HTML');
      const body = await res.text();
      assert.ok(body.includes('swagger-ui'), 'Should contain Swagger UI assets');
    });
  });

  describe('OpenAPI Specification Structure & Metadata', () => {
    it('declares OpenAPI 3.0.0 and correct service info', () => {
      assert.ok(openapi.openapi.startsWith('3.0'), 'Must target OpenAPI 3.0.x');
      assert.ok(openapi.info.title.includes('Flock Energy'), 'Info title must identify service');
      assert.equal(openapi.info.version, '1.0.0');
      assert.ok(Array.isArray(openapi.servers) && openapi.servers.length > 0, 'Servers must be defined');
    });

    it('defines all required component schemas with concrete property models', () => {
      const { schemas } = openapi.components;
      assert.ok(schemas.MeterSummary, 'MeterSummary schema must exist');
      assert.ok(schemas.MeterDetails || schemas.MeterDetail, 'MeterDetails schema must exist');
      assert.ok(schemas.EnergyReading, 'EnergyReading schema must exist');
      assert.ok(schemas.Error, 'Error schema must exist');
      assert.ok(schemas.FeederHierarchy || schemas.HierarchyFeeder, 'FeederHierarchy schema must exist');

      assert.equal(schemas.Error.properties.error.type, 'string');
      assert.equal(schemas.Error.properties.message.type, 'string');

      const meterProps = schemas.MeterSummary.properties;
      ['meterId', 'serialNo', 'make', 'phaseType', 'installStatus', 'dtCode'].forEach(prop => {
        assert.ok(meterProps[prop], `MeterSummary must have ${prop}`);
      });

      const energyProps = schemas.EnergyReading.properties;
      ['timestamp', 'rawTimestamp', 'kwh', 'kvah', 'voltR'].forEach(prop => {
        assert.ok(energyProps[prop], `EnergyReading must have ${prop}`);
      });
    });
  });

  describe('Express Route Registration & OpenAPI Parity', () => {
    it('every public API route declared in Express has a matching path in openapi.json', () => {
      const expressRoutes = [];

      app._router.stack.forEach((middleware) => {
        if (middleware.route) {
          const pathStr = middleware.route.path;
          const methods = Object.keys(middleware.route.methods);
          if (Array.isArray(pathStr)) {
            pathStr.forEach(p => expressRoutes.push({ path: p, methods }));
          } else {
            expressRoutes.push({ path: pathStr, methods });
          }
        }
      });

      const apiRoutes = expressRoutes.filter(r => r.path !== '/' && !r.path.startsWith('/docs'));

      for (const route of apiRoutes) {
        const openapiPath = route.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
        assert.ok(
          openapi.paths[openapiPath],
          `Express route "${route.path}" (normalized to "${openapiPath}") must be declared in openapi.json`
        );

        for (const method of route.methods) {
          assert.ok(
            openapi.paths[openapiPath][method.toLowerCase()],
            `Method "${method}" for route "${openapiPath}" must be documented in openapi.json`
          );
        }
      }
    });

    it('path parameters are correctly declared in openapi.json', () => {
      const meterDetailParams = openapi.paths['/api/v1/meters/{id}'].get.parameters;
      const idParam = meterDetailParams.find(p => p.name === 'id' && p.in === 'path');
      assert.ok(idParam, 'Path parameter "id" must be defined for /api/v1/meters/{id}');
      assert.equal(idParam.required, true, 'Path parameter "id" must be required');
    });

    it('query parameters for filtering and pagination are documented for /api/v1/meters', () => {
      const meterParams = openapi.paths['/api/v1/meters'].get.parameters.map(p => p.name);
      ['q', 'make', 'status', 'page'].forEach(param => {
        assert.ok(meterParams.includes(param), `Query parameter "${param}" must be declared for /api/v1/meters`);
      });
    });
  });

  describe('Sample Payload Conformance with Schemas', () => {
    it('sample MeterSummary conforms to schema properties', () => {
      const sample = {
        meterId: 'J100000',
        serialNo: 'SE33962',
        make: 'HPL',
        phaseType: 'single',
        installStatus: 'Decommissioned',
        dtCode: 'DT-001'
      };

      const schema = openapi.components.schemas.MeterSummary;
      for (const [key, prop] of Object.entries(schema.properties)) {
        assert.equal(typeof sample[key], prop.type);
      }
    });

    it('sample EnergyReading conforms to schema properties and types', () => {
      const sample = {
        timestamp: '2026-06-23T23:30:00+05:30',
        rawTimestamp: '23/06/2026 23:30',
        kwh: 48438.74,
        kvah: 52313.84,
        voltR: 226
      };

      const schema = openapi.components.schemas.EnergyReading;
      assert.equal(typeof sample.timestamp, schema.properties.timestamp.type);
      assert.equal(typeof sample.rawTimestamp, schema.properties.rawTimestamp.type);
      assert.equal(typeof sample.kwh, schema.properties.kwh.type);
      assert.equal(typeof sample.kvah, schema.properties.kvah.type);
      assert.equal(typeof sample.voltR, schema.properties.voltR.type);
    });

    it('sample Error conforms to schema properties', () => {
      const sample = {
        error: 'not_found',
        message: 'Meter not found'
      };

      const schema = openapi.components.schemas.Error;
      assert.equal(typeof sample.error, schema.properties.error.type);
      assert.equal(typeof sample.message, schema.properties.message.type);
    });
  });
});
