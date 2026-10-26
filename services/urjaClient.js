require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

function createUrjaClient(options = {}) {
  const baseURL = options.baseURL || process.env.UPSTREAM_BASE_URL || 'https://urja-ops.flockenergy.tech';
  const username = options.username || process.env.PORTAL_USERNAME || 'operator@urja.local';
  const password = options.password || process.env.PORTAL_PASSWORD || 'urja-ops-2026';
  const jar = options.jar || new CookieJar(null, { prefixSecurity: 'unsafe-disabled' });

  const client = wrapper(axios.create({
    baseURL,
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }));

  const authClient = wrapper(axios.create({
    baseURL,
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }));

  let loginPromise = null;

  async function authenticate() {
    if (loginPromise) {
      return loginPromise;
    }

    loginPromise = (async () => {
      try {
        const payload = new URLSearchParams({ email: username, password });
        const response = await authClient.post('/login', payload.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-sveltekit-action': 'true',
            'Origin': baseURL,
            'Referer': `${baseURL}/login`,
            'Accept': 'application/json'
          }
        });
        return response;
      } finally {
        loginPromise = null;
      }
    })();

    return loginPromise;
  }

  client.interceptors.response.use(
    async (response) => {
      const finalUrl = response.request?.res?.responseUrl || '';
      const isLoginHtml = typeof response.data === 'string' &&
        (response.data.includes('x-sveltekit-action') || response.data.includes('name="password"') || finalUrl.includes('/login'));

      if (isLoginHtml && !response.config._isRetry) {
        response.config._isRetry = true;
        await authenticate();
        return client(response.config);
      }

      return response;
    },
    async (error) => {
      const originalRequest = error.config;

      if (error.response?.status === 403) {
        return Promise.reject(error);
      }

      if (error.response?.status === 401 && originalRequest && !originalRequest._isRetry) {
        originalRequest._isRetry = true;
        try {
          await authenticate();
          return client(originalRequest);
        } catch (authError) {
          return Promise.reject(authError);
        }
      }

      return Promise.reject(error);
    }
  );

  async function fetchMeters(query = {}) {
    const rawQ = query.q !== undefined && query.q !== null ? query.q : '';
    const q = Array.isArray(rawQ) ? String(rawQ[0]).trim() : String(rawQ).trim();
    const encodedQ = encodeURIComponent(q);

    const firstPageResp = await client.get(`/portal/meters/search?q=${encodedQ}&page=1`);
    const firstPageData = firstPageResp.data || {};
    const total = firstPageData.total || 0;
    const pageSize = firstPageData.pageSize || 20;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

    let allMeters = [...(firstPageData.data || [])];

    if (totalPages > 1) {
      const pagePromises = [];
      for (let page = 2; page <= totalPages; page++) {
        pagePromises.push(client.get(`/portal/meters/search?q=${encodedQ}&page=${page}`));
      }
      const pageResponses = await Promise.all(pagePromises);
      for (const resp of pageResponses) {
        if (resp.data && Array.isArray(resp.data.data)) {
          allMeters.push(...resp.data.data);
        }
      }
    }

    let filtered = allMeters;

    if (query.make) {
      const targetMake = String(query.make).toLowerCase().trim();
      filtered = filtered.filter(m => m.make && m.make.toLowerCase() === targetMake);
    }

    if (query.status) {
      const targetStatus = String(query.status).toLowerCase().trim();
      filtered = filtered.filter(m => m.installStatus && m.installStatus.toLowerCase() === targetStatus);
    }

    return {
      total: filtered.length,
      data: filtered
    };
  }

  function parseNameplateHtml(html) {
    const cheerio = require('cheerio');
    const $ = cheerio.load(html || '');
    const nameplate = {};

    $('dl dt').each((_, el) => {
      const rawKey = $(el).text().trim();
      const val = $(el).next('dd').text().trim();
      if (!rawKey) return;

      const normalizedKey = rawKey.replace(/\s+/g, '').toLowerCase();

      switch (normalizedKey) {
        case 'meterid':
          nameplate.meterId = val;
          break;
        case 'serialno':
          nameplate.serialNo = val;
          break;
        case 'make':
          nameplate.make = val;
          break;
        case 'phasetype':
          nameplate.phaseType = val;
          break;
        case 'installationstatus':
        case 'installstatus':
          nameplate.installStatus = val;
          break;
        case 'installationtype':
        case 'installtype':
          nameplate.installType = val;
          break;
        default:
          nameplate[rawKey] = val;
          break;
      }
    });

    return nameplate;
  }

  async function getMeterDetail(meterId) {
    const [htmlResult, geoResult] = await Promise.allSettled([
      client.get(`/meters/${meterId}`, {
        headers: { Accept: 'text/html,application/xhtml+xml' }
      }),
      client.get(`/portal/meters/${meterId}/geo`)
    ]);

    if (htmlResult.status === 'rejected') {
      const err = htmlResult.reason;
      if (err.response?.status === 404) {
        const notFoundErr = new Error(`Meter ${meterId} not found`);
        notFoundErr.status = 404;
        notFoundErr.code = 'not_found';
        throw notFoundErr;
      }
      throw err;
    }

    const nameplate = parseNameplateHtml(htmlResult.value.data);

    if (!nameplate.meterId && !nameplate.serialNo) {
      const notFoundErr = new Error(`Meter ${meterId} not found`);
      notFoundErr.status = 404;
      notFoundErr.code = 'not_found';
      throw notFoundErr;
    }

    let location = null;
    if (geoResult.status === 'fulfilled') {
      const geoData = geoResult.value.data?.data || geoResult.value.data || {};
      if (geoData.latitude !== undefined && geoData.longitude !== undefined &&
        geoData.latitude !== null && geoData.longitude !== null) {
        location = {
          latitude: Number(geoData.latitude),
          longitude: Number(geoData.longitude)
        };
      }
    } else {
      const geoErr = geoResult.reason;
      if (geoErr.response?.status !== 404) {
        console.warn(`[Urja Client] Geo coordinate retrieval failure for ${meterId}:`, geoErr.message);
      }
    }

    return {
      ...nameplate,
      location
    };
  }

  return {
    client,
    authenticate,
    fetchMeters,
    getMeterDetail,
    parseNameplateHtml,
    jar,
    baseURL
  };
}

const defaultInstance = createUrjaClient();

module.exports = {
  ...defaultInstance,
  createUrjaClient
};
