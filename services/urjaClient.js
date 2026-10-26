require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

/**
 * Factory function to create an authenticated Urja Portal client instance.
 * Supports custom baseURL and credentials for isolated unit testing.
 */
function createUrjaClient(options = {}) {
  const baseURL = options.baseURL || process.env.UPSTREAM_BASE_URL || 'https://urja-ops.flockenergy.tech';
  const username = options.username || process.env.PORTAL_USERNAME || 'operator@urja.local';
  const password = options.password || process.env.PORTAL_PASSWORD || 'urja-ops-2026';
  const jar = options.jar || new CookieJar(null, { prefixSecurity: 'unsafe-disabled' });

  // Create base Axios instance with tough-cookie jar support
  const client = wrapper(axios.create({
    baseURL,
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }));

  // Separate client for authentication to prevent interceptor recursion
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

  /**
   * Performs SvelteKit action login with concurrency locking.
   * Multiple concurrent callers await the same authentication promise.
   */
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

  // Response Interceptor: Self-healing session recovery
  client.interceptors.response.use(
    async (response) => {
      // Check if upstream silently redirected an expired session to the login page (HTTP 200)
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

      // Do NOT retry on 403 Forbidden (CSRF / permission issues, not expired session)
      if (error.response?.status === 403) {
        return Promise.reject(error);
      }

      // Re-authenticate and retry at most once on 401 Unauthorized
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

  return {
    client,
    authenticate,
    jar,
    baseURL
  };
}

// Export default singleton instance for application use
const defaultInstance = createUrjaClient();

module.exports = {
  ...defaultInstance,
  createUrjaClient
};
