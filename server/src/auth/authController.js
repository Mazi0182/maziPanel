const express = require('express');
const router = express.Router();
const config = require('../../config');
const authService = require('./authService');
const authMiddleware = require('./authMiddleware');
const tokenPolicy = require('./tokenPolicy');
const rateLimiter = require('./rateLimiter');

function setAuthCookie(req, res, token) {
  const isSecure = Boolean(req.secure || (config.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https'));
  res.cookie('mazipanel_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecure,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/'
  });
}

function clearAuthCookie(res) {
  res.clearCookie('mazipanel_session', { path: '/' });
  res.clearCookie('token', { path: '/' });
  res.clearCookie('auth_token', { path: '/' });
  res.clearCookie('jwt', { path: '/' });
}

function checkOrigin(req, res, next) {
  if (req.headers.origin && !tokenPolicy.isOriginAllowed(req)) {
    return res.status(403).json({ error: 'Çapraz kaynaklı istek reddedildi.' });
  }
  next();
}

// Check setup status - NEVER leaks username
router.get('/status', (req, res) => {
  try {
    const status = authService.getStatus();
    res.json({
      initialized: Boolean(status.initialized)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initial Master Admin Setup Wizard (Origin validated, rate limited)
router.post('/setup', checkOrigin, async (req, res) => {
  const clientIp = req.ip || req.socket?.remoteAddress;
  const rateCheck = rateLimiter.check(clientIp, 'setup');
  if (rateCheck.blocked) {
    res.setHeader('Retry-After', String(rateCheck.retryAfter));
    return res.status(429).json({
      error: `Çok fazla başarısız deneme yapıldı. Lütfen ${rateCheck.retryAfter} saniye sonra tekrar deneyin.`,
      retryAfter: rateCheck.retryAfter
    });
  }

  try {
    const { username, password, passwordHint } = req.body;
    const result = await authService.setupAdmin(username, password, passwordHint);
    rateLimiter.reset(clientIp, 'setup');

    if (result && result.token) {
      setAuthCookie(req, res, result.token);
    }
    res.status(201).json(result);
  } catch (err) {
    const failStatus = rateLimiter.recordFailure(clientIp, 'setup');
    if (failStatus.blocked) {
      res.setHeader('Retry-After', String(failStatus.retryAfter));
      return res.status(429).json({
        error: `Çok fazla başarısız deneme yapıldı. Lütfen ${failStatus.retryAfter} saniye sonra tekrar deneyin.`,
        retryAfter: failStatus.retryAfter
      });
    }
    res.status(400).json({ error: err.message });
  }
});

// User Login (Origin validated, rate limited with progressive backoff)
router.post('/login', checkOrigin, async (req, res) => {
  const clientIp = req.ip || req.socket?.remoteAddress;
  const { username, password } = req.body;

  const rateCheck = rateLimiter.check(clientIp, username);
  if (rateCheck.blocked) {
    res.setHeader('Retry-After', String(rateCheck.retryAfter));
    return res.status(429).json({
      error: `Çok fazla başarısız deneme yapıldı. Lütfen ${rateCheck.retryAfter} saniye sonra tekrar deneyin.`,
      retryAfter: rateCheck.retryAfter
    });
  }

  try {
    const result = await authService.login(username, password);
    rateLimiter.reset(clientIp, username);

    if (result && result.token) {
      setAuthCookie(req, res, result.token);
    }
    res.json(result);
  } catch (err) {
    const failStatus = rateLimiter.recordFailure(clientIp, username);
    if (failStatus.blocked) {
      res.setHeader('Retry-After', String(failStatus.retryAfter));
      return res.status(429).json({
        error: `Çok fazla başarısız deneme yapıldı. Lütfen ${failStatus.retryAfter} saniye sonra tekrar deneyin.`,
        retryAfter: failStatus.retryAfter
      });
    }
    res.status(401).json({ error: err.message || 'Geçersiz kullanıcı adı veya şifre.' });
  }
});

// Logout (Origin validated)
router.post('/logout', checkOrigin, (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true, message: 'Başarıyla çıkış yapıldı.' });
});

// Revoke all sessions across devices
router.post('/logout-all', authMiddleware, checkOrigin, (req, res) => {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ error: 'Oturum açılması gerekiyor.' });
    }
    authService.revokeAllSessions(req.user.username);
    clearAuthCookie(res);
    res.json({ success: true, message: 'Tüm oturumlardan başarıyla çıkış yapıldı.' });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Current User Details - available to authenticated users
router.get('/me', authMiddleware, (req, res) => {
  if (!req.user || !req.user.username) {
    return res.status(401).json({ error: 'Oturum açılması gerekiyor.' });
  }

  const freshUser = authService.getUser(req.user.username);
  if (!freshUser) {
    return res.json({
      user: {
        username: req.user.username,
        role: req.user.role,
        tokenVersion: req.user.tokenVersion || 0,
        passwordHint: null,
        createdAt: null
      }
    });
  }

  res.json({
    user: {
      username: freshUser.username,
      role: freshUser.role,
      tokenVersion: freshUser.tokenVersion || 0,
      passwordHint: freshUser.passwordHint || null,
      createdAt: freshUser.createdAt
    }
  });
});

// Refresh active session token (sliding window renewal)
router.post('/refresh', authMiddleware, checkOrigin, (req, res) => {
  if (!req.user || !req.user.username) {
    return res.status(401).json({ error: 'Oturum açılması gerekiyor.' });
  }

  const freshUser = authService.getUser(req.user.username);
  if (!freshUser) {
    return res.status(401).json({ error: 'Kullanıcı bulunamadı.' });
  }

  const token = authService.generateToken({
    username: freshUser.username,
    role: freshUser.role,
    tokenVersion: freshUser.tokenVersion || 0
  });
  setAuthCookie(req, res, token);

  res.json({
    success: true,
    token,
    user: {
      username: freshUser.username,
      role: freshUser.role,
      tokenVersion: freshUser.tokenVersion || 0,
      passwordHint: freshUser.passwordHint || null,
      createdAt: freshUser.createdAt
    }
  });
});

// List all users - Admin only
router.get('/users', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
  try {
    const users = authService.listUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new user - Admin only
router.post('/users', authMiddleware, authMiddleware.requireAdmin, checkOrigin, async (req, res) => {
  try {
    const { username, password, role, passwordHint } = req.body;
    const user = await authService.createUser({ username, password, role, passwordHint });
    res.status(201).json({
      success: true,
      message: 'Kullanıcı başarıyla oluşturuldu.',
      user
    });
  } catch (err) {
    const statusCode = err.status || 400;
    res.status(statusCode).json({ error: err.message });
  }
});

// Update user details - Admin or Self
router.put('/users/:username', authMiddleware, checkOrigin, async (req, res) => {
  try {
    const targetUsername = req.params.username;
    const result = await authService.updateUser(targetUsername, req.body, req.user);
    if (result && result.token) {
      setAuthCookie(req, res, result.token);
    }
    res.json(result);
  } catch (err) {
    const statusCode = err.status || 400;
    res.status(statusCode).json({ error: err.message });
  }
});

// Delete user - Admin only
router.delete('/users/:username', authMiddleware, authMiddleware.requireAdmin, checkOrigin, (req, res) => {
  try {
    const targetUsername = req.params.username;
    const result = authService.deleteUser(targetUsername, req.user);
    res.json(result);
  } catch (err) {
    const statusCode = err.status || 400;
    res.status(statusCode).json({ error: err.message });
  }
});

module.exports = router;
