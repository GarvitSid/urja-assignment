require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const { fetchMeters, getMeterDetail, getMeterEnergy, getNetworkHierarchy } = require('./services/urjaClient');

function validateMeterId(req, res, next) {
  const { id } = req.params;
  if (!id || !/^[A-Z0-9]+$/i.test(id)) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Invalid meter ID format. Expected alphanumeric string.'
    });
  }
  next();
}

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/v1/meters', async (req, res, next) => {
  try {
    const { q, make, status, page, pageSize } = req.query;
    const result = await fetchMeters({ q, make, status });

    if (page !== undefined) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limit = Math.max(1, parseInt(pageSize, 10) || 20);
      const start = (pageNum - 1) * limit;
      const paginatedData = result.data.slice(start, start + limit);

      return res.status(200).json({
        total: result.total,
        page: pageNum,
        pageSize: limit,
        totalPages: Math.ceil(result.total / limit),
        data: paginatedData
      });
    }

    res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/meters/:id', validateMeterId, async (req, res, next) => {
  try {
    const meter = await getMeterDetail(req.params.id);
    res.status(200).json(meter);
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/meters/:id/energy', validateMeterId, async (req, res, next) => {
  try {
    const { limit } = req.query;

    if (limit !== undefined) {
      const parsed = Number(limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json({
          error: 'bad_request',
          message: 'Invalid limit parameter. Expected a positive integer.'
        });
      }
    }

    const readings = await getMeterEnergy(req.params.id, limit);
    res.status(200).json(readings);
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/meters/:id/consumption', (req, res, next) => {
  req.url = req.url.replace('/consumption', '/energy');
  app.handle(req, res, next);
});

app.get('/api/v1/network/hierarchy', async (req, res, next) => {
  try {
    const hierarchy = await getNetworkHierarchy();
    res.status(200).json(hierarchy);
  } catch (err) {
    next(err);
  }
});

app.get(['/api/v1/hierarchy', '/hierarchy'], (req, res, next) => {
  req.url = '/api/v1/network/hierarchy';
  app.handle(req, res, next);
});

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

app.use((err, req, res, next) => {
  console.error('[Unhandled Error]:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.code || 'internal_error',
    message: err.message || 'Internal server error'
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Urja Service] Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
