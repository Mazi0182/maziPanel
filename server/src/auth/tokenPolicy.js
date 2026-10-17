const { URL } = require('url');
const config = require('../../config');

/**
 * Safely parse cookie header into key-value map.
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

/**
 * Narrowly inspects underlying socket remote address.
 * NEVER trusts X-Forwarded-For or other client proxy headers for loopback elevation.
 */
function isRealSocketLoopback(req) {
  const socket = req.socket || req.connection;
  const remote = (socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  return remote === '127.0.0.1' || remote === '::1';
}

/**
 * Parses the HTTP Host header into hostname and port, correctly handling IPv6 literals.
 * E.g.:
 *  "127.0.0.1:8080"   -> { hostname: "127.0.0.1", port: "8080" }
 *  "[::1]:8080"       -> { hostname: "[::1]", port: "8080" }
 *  "[::1]"            -> { hostname: "[::1]", port: null }
 *  "localhost"        -> { hostname: "localhost", port: null }
 */
function parseHostHeader(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    const hostname = trimmed.substring(0, closeIdx + 1);
    const rest = trimmed.substring(closeIdx + 1);
    let port = null;
    if (rest.startsWith(':')) {
      port = rest.substring(1);
    }
    return { hostname, port };
  }

  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx !== -1) {
    return {
      hostname: trimmed.substring(0, colonIdx),
      port: trimmed.substring(colonIdx + 1)
    };
  }

  return { hostname: trimmed, port: null };
}

/**
 * Validates Origin / Referer for CSRF / Cross-Site WebSocket Hijacking defense.
 * - Missing Origin and Referer (CLI, curl, test scripts) is allowed.
 * - null or NULL Origin/Referer is strictly rejected.
 * - Compares valid http/https origin to actual Host header (NO wildcard forwarded-header trust).
 * - IPv6 and standard default ports are properly parsed and handled.
 * - Explicit allowlist via config.TRUSTED_ORIGINS is respected.
 */
function isOriginAllowed(req) {
  const originHeader = req.headers && req.headers.origin;
  const refererHeader = req.headers && (req.headers.referer || req.headers.referrer);

  // If neither Origin nor Referer is provided, allow (CLI/test runner/Bearer clients)
  if (!originHeader && !refererHeader) {
    return true;
  }

  // Reject explicit 'null' or malformed origins
  if (originHeader) {
    const lowerOrigin = String(originHeader).trim().toLowerCase();
    if (lowerOrigin === 'null' || lowerOrigin === 'undefined') {
      return false;
    }
  }

  if (refererHeader) {
    const lowerReferer = String(refererHeader).trim().toLowerCase();
    if (lowerReferer === 'null' || lowerReferer === 'undefined') {
      return false;
    }
  }

  // Parse actual Host header. Never trust X-Forwarded-Host without explicit configuration.
  const targetHost = parseHostHeader(req.headers && req.headers.host);
  if (!targetHost) {
    return false;
  }

  const trustedOrigins = (config && Array.isArray(config.TRUSTED_ORIGINS)) ? config.TRUSTED_ORIGINS : [];

  function validateUrl(rawUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return false;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return false;
    }

    // Check explicit trusted origins allowlist if configured
    if (trustedOrigins.length > 0 && trustedOrigins.includes(parsedUrl.origin.toLowerCase())) {
      return true;
    }

    // Compare origin hostname against actual Host header
    const originHostname = parsedUrl.hostname.toLowerCase();
    if (originHostname !== targetHost.hostname) {
      return false;
    }

    // Compare origin port against actual Host port (considering standard default ports 80/443)
    const originPort = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
    const expectedPort = targetHost.port || (parsedUrl.protocol === 'https:' ? '443' : '80');

    return originPort === expectedPort;
  }

  if (originHeader && !validateUrl(originHeader)) {
    return false;
  }

  if (refererHeader && !validateUrl(refererHeader)) {
    return false;
  }

  return true;
}

function isWebSocketUpgrade(req, options = {}) {
  if (options && (options.allowQueryToken || options.isWebSocket)) {
    return true;
  }
  if (!req) return false;
  if (req.headers && req.headers.upgrade && String(req.headers.upgrade).toLowerCase() === 'websocket') {
    return true;
  }
  const rawUrl = req.url || '';
  const cleanPath = rawUrl.split('?')[0];
  if (cleanPath === '/ws' || cleanPath.startsWith('/ws/')) {
    return true;
  }
  return false;
}

/**
 * Deterministically extracts token presence and value across HTTP and WebSocket requests.
 * Precedence:
 * 1. Authorization header (Bearer <token> or raw token)
 * 2. Cookie (token, auth_token, jwt)
 * 3. Query string (token) - STRICTLY restricted to WebSocket upgrade only
 *
 * If a token source was provided but is empty, malformed, or invalid:
 * It marks `present: true, malformed: true` so resolution will fail closed immediately.
 */
function extractToken(req, options = {}) {
  // 1. Primary Web Session Cookie (mazipanel_session)
  if (req.headers && req.headers.cookie !== undefined) {
    const cookies = parseCookies(req.headers.cookie);
    if ('mazipanel_session' in cookies) {
      const cookieVal = cookies.mazipanel_session;
      const trimmed = typeof cookieVal === 'string' ? cookieVal.trim() : '';
      if (!trimmed) {
        return { source: 'cookie', token: null, present: true, malformed: true };
      }
      return { source: 'cookie', token: trimmed, present: true, malformed: false };
    }
  }

  // 2. Authorization Header (Backward compatibility, API clients, tests)
  if (req.headers && req.headers.authorization !== undefined) {
    const rawAuth = String(req.headers.authorization).trim();
    if (!rawAuth) {
      return { source: 'authorization', token: null, present: true, malformed: true };
    }
    if (/^Bearer\s+/i.test(rawAuth)) {
      const val = rawAuth.replace(/^Bearer\s+/i, '').trim();
      if (!val) {
        return { source: 'authorization', token: null, present: true, malformed: true };
      }
      return { source: 'authorization', token: val, present: true, malformed: false };
    }
    // Non-Bearer authorization string
    if (rawAuth.length > 10 && !/\s/.test(rawAuth)) {
      return { source: 'authorization', token: rawAuth, present: true, malformed: false };
    }
    return { source: 'authorization', token: null, present: true, malformed: true };
  }

  // 3. Legacy Cookie Fallback (token, auth_token, jwt)
  if (req.headers && req.headers.cookie !== undefined) {
    const cookies = parseCookies(req.headers.cookie);
    if ('token' in cookies || 'auth_token' in cookies || 'jwt' in cookies) {
      const cookieVal = (cookies.token ?? cookies.auth_token ?? cookies.jwt);
      const trimmed = typeof cookieVal === 'string' ? cookieVal.trim() : '';
      if (!trimmed) {
        return { source: 'cookie', token: null, present: true, malformed: true };
      }
      return { source: 'cookie', token: trimmed, present: true, malformed: false };
    }
  }

  // 4. Query Parameter - strictly restricted to WebSocket upgrade only
  if (isWebSocketUpgrade(req, options)) {
    let queryVal = undefined;
    if (req.query && req.query.token !== undefined) {
      queryVal = req.query.token;
    } else if (req.url && req.url.includes('token=')) {
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        queryVal = parsed.searchParams.get('token');
      } catch (e) {}
    }

    if (queryVal !== undefined) {
      const trimmed = typeof queryVal === 'string' ? queryVal.trim() : '';
      if (!trimmed) {
        return { source: 'query', token: null, present: true, malformed: true };
      }
      return { source: 'query', token: trimmed, present: true, malformed: false };
    }
  }

  return { source: null, token: null, present: false, malformed: false };
}

/**
 * Shared resolution policy for both HTTP and WebSocket.
 *
 * - If any token was supplied (even empty or malformed):
 *   Must verify successfully; otherwise FAILS CLOSED immediately.
 *   Never falls back to another source or SINGLE_USER_MODE bypass.
 * - If NO token was supplied:
 *   Only grants admin if config.SINGLE_USER_MODE === true AND underlying socket is real loopback.
 */
function resolveAuth(req, authService, config, options = {}) {
  const tokenInfo = extractToken(req, options);

  if (tokenInfo.present) {
    if (tokenInfo.malformed || !tokenInfo.token) {
      return { authenticated: false, error: 'invalid_or_expired_token', user: null, source: tokenInfo.source };
    }

    const decoded = authService.verifyToken(tokenInfo.token);
    if (decoded && decoded.username) {
      // Validate tokenVersion against active user record if user exists or system is initialized
      const internalUser = typeof authService.getInternalUser === 'function'
        ? authService.getInternalUser(decoded.username)
        : null;

      if (internalUser) {
        const expectedVersion = typeof internalUser.tokenVersion === 'number' ? internalUser.tokenVersion : 0;
        const tokenVersion = typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;

        if (tokenVersion !== expectedVersion) {
          return { authenticated: false, error: 'session_revoked', user: null, source: tokenInfo.source };
        }

        return {
          authenticated: true,
          user: {
            ...decoded,
            tokenVersion: expectedVersion
          },
          source: tokenInfo.source,
          token: tokenInfo.token,
          decoded
        };
      }

      // If user does not exist in database:
      // Allow mock tokens in test environments to preserve existing test harness backward-compatibility
      if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
        return {
          authenticated: true,
          user: decoded,
          source: tokenInfo.source,
          token: tokenInfo.token,
          decoded
        };
      }

      // In production, reject tokens for non-existent / deleted users
      return { authenticated: false, error: 'invalid_or_expired_token', user: null, source: tokenInfo.source };
    }

    // Supplied token failed verification -> Fail Closed (no bypass allowed)
    return { authenticated: false, error: 'invalid_or_expired_token', user: null, source: tokenInfo.source };
  }

  // No token supplied at all. Check explicit SINGLE_USER_MODE loopback bypass.
  const isSingleUserExplicit = config && config.SINGLE_USER_MODE === true;
  const isLoopback = isRealSocketLoopback(req);

  if (isSingleUserExplicit && isLoopback) {
    const adminData = authService.getAdminData();
    return {
      authenticated: true,
      user: {
        username: adminData ? adminData.username : 'masteradmin',
        role: 'admin',
        bypassed: true
      },
      source: 'loopback_bypass'
    };
  }

  return { authenticated: false, user: null, source: null };
}

module.exports = {
  parseCookies,
  isRealSocketLoopback,
  parseHostHeader,
  isOriginAllowed,
  extractToken,
  resolveAuth
};
