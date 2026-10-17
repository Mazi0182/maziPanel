const authService = require('./authService');
const config = require('../../config');
const tokenPolicy = require('./tokenPolicy');

function authMiddleware(req, res, next) {
  const isStateChanging = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';

  // 1. Cross-Origin CSRF Defense:
  // If Origin or Referer header is present on state-changing HTTP requests, it must match the server Host.
  if (isStateChanging && (req.headers.origin || req.headers.referer || req.headers.referrer) && !tokenPolicy.isOriginAllowed(req)) {
    return res.status(403).json({ error: 'Çapraz kaynaklı istek reddedildi.' });
  }

  // 2. Resolve authentication using shared deterministic policy
  const authResult = tokenPolicy.resolveAuth(req, authService, config);

  if (authResult.authenticated) {
    req.user = authResult.user;

    // Cookie-authenticated state-changing requests must also satisfy same-origin validation
    if (authResult.source === 'cookie' && isStateChanging && (req.headers.origin || req.headers.referer) && !tokenPolicy.isOriginAllowed(req)) {
      return res.status(403).json({ error: 'Çapraz kaynaklı istek reddedildi.' });
    }

    // Require valid authenticated role ('admin' or 'user')
    if (req.user.role !== 'admin' && req.user.role !== 'user') {
      return res.status(403).json({ error: 'Geçersiz kullanıcı rolü.' });
    }

    // Sliding session: If authenticated via cookie and token age exceeds threshold (1 day), silently refresh cookie
    if (authResult.source === 'cookie' && authResult.decoded && authResult.decoded.iat) {
      const tokenAgeSec = Math.floor(Date.now() / 1000) - authResult.decoded.iat;
      if (tokenAgeSec >= 86400 && typeof res.cookie === 'function') {
        const freshToken = authService.generateToken({
          username: req.user.username,
          role: req.user.role,
          tokenVersion: req.user.tokenVersion || 0
        });
        const isSecure = Boolean(req.secure || (config.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https'));
        res.cookie('mazipanel_session', freshToken, {
          httpOnly: true,
          sameSite: 'strict',
          secure: isSecure,
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: '/'
        });
      }
    }

    return next();
  }

  if (authResult.error) {
    // A token was supplied (in Authorization header, Cookie, or Query) but failed verification.
    // Fail closed immediately: never bypass to guest, single-user mode, or bootstrap.
    return res.status(401).json({ error: 'Oturum geçersiz veya süresi dolmuş.' });
  }

  // 3. Unauthenticated request: check strictly necessary public bootstrap endpoints
  const rawUrl = req.originalUrl || req.url || '';
  const cleanPath = rawUrl.split('?')[0];
  const method = req.method;
  const isReadOnly = method === 'GET' || method === 'HEAD';

  // Health and Auth bootstrap status
  if (isReadOnly && (cleanPath === '/api/health' || cleanPath === '/api/auth/status')) {
    req.user = { username: 'anonymous', role: 'bootstrap', isBootstrap: true };
    return next();
  }

  // Initial Master Admin Setup and Login endpoints
  if (method === 'POST' && (cleanPath === '/api/auth/setup' || cleanPath === '/api/auth/login')) {
    req.user = { username: 'anonymous', role: 'bootstrap', isBootstrap: true };
    return next();
  }

  // Public server icons
  const isServerIcon = isReadOnly && /^\/api\/servers\/[^\/]+\/icon$/.test(cleanPath);
  if (isServerIcon) {
    req.user = { username: 'guest', role: 'guest', isPublic: true };
    return next();
  }

  // All other endpoints require authentication!
  return res.status(401).json({ error: 'Oturum açılması gerekiyor.' });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
  }
  next();
}

// Export helpers directly for backward compatibility
authMiddleware.requireAdmin = requireAdmin;
authMiddleware.parseCookies = tokenPolicy.parseCookies;
authMiddleware.isRealSocketLoopback = tokenPolicy.isRealSocketLoopback;
authMiddleware.parseHostHeader = tokenPolicy.parseHostHeader;
authMiddleware.isOriginAllowed = tokenPolicy.isOriginAllowed;
authMiddleware.extractToken = tokenPolicy.extractToken;
authMiddleware.resolveAuth = tokenPolicy.resolveAuth;

module.exports = authMiddleware;
