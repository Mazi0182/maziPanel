/**
 * In-memory sliding rate limiter for authentication endpoints.
 * Protects against brute-force password guessing attacks.
 * Tracks failed attempts per IP + normalized username.
 */

class AuthRateLimiter {
  constructor() {
    this.attempts = new Map();
    // Periodically prune stale entries every 5 minutes to prevent memory leak
    this._cleanupTimer = setInterval(() => this.pruneStale(), 5 * 60 * 1000);
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }

  _getKey(ip, username = '') {
    const cleanIp = String(ip || 'unknown').trim().replace(/^::ffff:/, '');
    const cleanUser = String(username || '').trim().toLowerCase();
    return cleanUser ? `${cleanIp}:${cleanUser}` : cleanIp;
  }

  _getIpKey(ip) {
    const cleanIp = String(ip || 'unknown').trim().replace(/^::ffff:/, '');
    return `ip:${cleanIp}`;
  }

  _getMaxAttempts() {
    if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
      return parseInt(process.env.TEST_AUTH_RATE_LIMIT_MAX || '100', 10);
    }
    return 5;
  }

  _getIpMaxAttempts() {
    if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
      if (process.env.TEST_AUTH_IP_RATE_LIMIT_MAX) {
        return parseInt(process.env.TEST_AUTH_IP_RATE_LIMIT_MAX, 10);
      }
      return parseInt(process.env.TEST_AUTH_RATE_LIMIT_MAX || '100', 10);
    }
    return 20;
  }

  /**
   * Calculates progressive backoff delay in seconds:
   * 1st block: 30s
   * 2nd block: 60s (1m)
   * 3rd block: 120s (2m)
   * 4th+ block: 300s (5m max)
   */
  _getDelaySeconds(level) {
    if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
      // In tests allow quick overrides if specified
      if (process.env.TEST_AUTH_RATE_LIMIT_DELAY) {
        return parseInt(process.env.TEST_AUTH_RATE_LIMIT_DELAY, 10);
      }
    }
    switch (level) {
      case 1:
        return 30;
      case 2:
        return 60;
      case 3:
        return 120;
      default:
        return 300;
    }
  }

  _checkRecord(key) {
    const record = this.attempts.get(key);
    if (!record) {
      return { blocked: false, retryAfter: 0 };
    }

    const now = Date.now();
    if (record.blockedUntil && record.blockedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((record.blockedUntil - now) / 1000));
      return { blocked: true, retryAfter };
    }

    return { blocked: false, retryAfter: 0 };
  }

  /**
   * Checks if either overall IP or specific user is currently blocked.
   * Returns { blocked: boolean, retryAfter: number }
   */
  check(ip, username = '') {
    // 1. Check IP-wide overall rate limit first
    const ipKey = this._getIpKey(ip);
    const ipStatus = this._checkRecord(ipKey);
    if (ipStatus.blocked) {
      return ipStatus;
    }

    // 2. Check user-specific rate limit if username is provided
    const userKey = this._getKey(ip, username);
    if (userKey !== ipKey) {
      const userStatus = this._checkRecord(userKey);
      if (userStatus.blocked) {
        return userStatus;
      }
    }

    return { blocked: false, retryAfter: 0 };
  }

  _recordKeyFailure(key, maxAttempts) {
    const now = Date.now();
    let record = this.attempts.get(key);

    if (!record) {
      record = {
        failCount: 0,
        lockLevel: 0,
        blockedUntil: 0,
        lastAttempt: now
      };
      this.attempts.set(key, record);
    }

    record.lastAttempt = now;
    record.failCount += 1;

    if (record.failCount >= maxAttempts) {
      record.lockLevel += 1;
      const delaySec = this._getDelaySeconds(record.lockLevel);
      record.blockedUntil = now + delaySec * 1000;
      // Reset fail count counter so subsequent failures trigger the next backoff level
      record.failCount = 0;
      return { blocked: true, retryAfter: delaySec };
    }

    return { blocked: false, retryAfter: 0 };
  }

  /**
   * Records a failed login/setup attempt on both IP-wide and per-user counters.
   * Applies progressive lockout once max attempts are reached.
   */
  recordFailure(ip, username = '') {
    const ipKey = this._getIpKey(ip);
    const userKey = this._getKey(ip, username);

    const ipStatus = this._recordKeyFailure(ipKey, this._getIpMaxAttempts());
    let userStatus = { blocked: false, retryAfter: 0 };
    if (userKey !== ipKey) {
      userStatus = this._recordKeyFailure(userKey, this._getMaxAttempts());
    }

    if (userStatus.blocked || ipStatus.blocked) {
      const retryAfter = Math.max(userStatus.retryAfter || 0, ipStatus.retryAfter || 0);
      return { blocked: true, retryAfter };
    }

    return { blocked: false, retryAfter: 0 };
  }

  /**
   * Clears failure history upon successful authentication.
   */
  reset(ip, username = '') {
    const userKey = this._getKey(ip, username);
    this.attempts.delete(userKey);
    const ipKey = this._getIpKey(ip);
    this.attempts.delete(ipKey);
  }

  /**
   * Cleans up expired entries to protect memory.
   */
  pruneStale() {
    const now = Date.now();
    const expiryWindow = 30 * 60 * 1000; // 30 minutes inactivity
    for (const [key, record] of this.attempts.entries()) {
      if (record.blockedUntil < now && now - record.lastAttempt > expiryWindow) {
        this.attempts.delete(key);
      }
    }
  }

  /**
   * Express middleware factory for login or setup.
   */
  middleware(getIdentifier = (req) => ({ ip: req.ip || req.socket?.remoteAddress, username: req.body?.username })) {
    return (req, res, next) => {
      const { ip, username } = getIdentifier(req);
      const status = this.check(ip, username);
      if (status.blocked) {
        res.setHeader('Retry-After', String(status.retryAfter));
        return res.status(429).json({
          error: `Çok fazla başarısız deneme yapıldı. Lütfen ${status.retryAfter} saniye sonra tekrar deneyin.`,
          retryAfter: status.retryAfter
        });
      }
      next();
    };
  }
}

module.exports = new AuthRateLimiter();
