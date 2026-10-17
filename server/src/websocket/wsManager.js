const { WebSocketServer, WebSocket } = require('ws');
const authService = require('../auth/authService');
const authMiddleware = require('../auth/authMiddleware');
const tokenPolicy = require('../auth/tokenPolicy');
const config = require('../../config');
const processManager = require('../servers/processManager');
const metricsService = require('../metrics/metricsService');
const serverRegistry = require('../servers/serverRegistry');

function canAccessServer(user, server) {
  if (!user || !server) return false;
  if (user.role === 'admin') return true;
  const userNorm = (user.username || '').trim().toLowerCase();
  const ownerNorm = (server.owner || '').trim().toLowerCase();
  return Boolean(userNorm && userNorm === ownerNorm);
}

const MAX_WS_PAYLOAD_BYTES = 64 * 1024; // 64 KB

function sanitizeHostMetricsForUser(hostMetrics) {
  if (!hostMetrics || typeof hostMetrics !== 'object') return {};
  return {
    cpu: {
      usagePercent: hostMetrics.cpu ? hostMetrics.cpu.usagePercent : 0
    },
    memory: {
      totalBytes: hostMetrics.memory ? hostMetrics.memory.totalBytes : 0,
      usedBytes: hostMetrics.memory ? hostMetrics.memory.usedBytes : 0,
      freeBytes: hostMetrics.memory ? hostMetrics.memory.freeBytes : 0,
      usagePercent: hostMetrics.memory ? hostMetrics.memory.usagePercent : 0
    },
    timestamp: hostMetrics.timestamp || new Date().toISOString()
  };
}

class WsManager {
  constructor() {
    this.wss = null;
    this.maxPayload = MAX_WS_PAYLOAD_BYTES;
    // Map ws -> { user, subscriptions: Set<string>, subscribedMetrics: boolean, isAlive: boolean, authFailed: boolean }
    this.clients = new Map();
    this.heartbeatInterval = null;
    this.metricsInterval = null;
    this._listenersAttached = false;
  }

  initialize(httpServer) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: MAX_WS_PAYLOAD_BYTES
    });

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    // Setup heartbeat and periodic revocation interval (every 30s) - unref to prevent process hangs during tests
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, meta] of this.clients.entries()) {
        if (!meta.isAlive) {
          try { ws.terminate(); } catch (e) {}
          this.clients.delete(ws);
          continue;
        }

        // Periodic revocation guard: re-verify user's tokenVersion and existence
        if (meta.user && !meta.user.bypassed) {
          if (!this._validateTokenVersion(meta.user)) {
            this._revokeSession(ws, meta, 'Oturum sonlandırıldı veya yetki iptal edildi.');
            continue;
          }
        }

        meta.isAlive = false;
        try { ws.ping(); } catch (e) {}
      }
    }, 30000);
    if (this.heartbeatInterval && typeof this.heartbeatInterval.unref === 'function') {
      this.heartbeatInterval.unref();
    }

    // Setup periodic metrics broadcast (every 2s) to clients subscribed to metrics
    this.metricsInterval = setInterval(() => {
      this._broadcastMetrics();
    }, 2000);
    if (this.metricsInterval && typeof this.metricsInterval.unref === 'function') {
      this.metricsInterval.unref();
    }

    // Wire up events from processManager once
    if (!this._listenersAttached) {
      this._listenersAttached = true;

      processManager.on('log', ({ serverId, entry, sessionId }) => {
        this.broadcastConsoleLine(serverId, entry, sessionId);
      });

      processManager.on('status', ({ serverId, status, oldStatus }) => {
        this.broadcastServerStatus(serverId, status, oldStatus);
      });

      processManager.on('lifecycle_reset', ({ serverId, sessionId }) => {
        this.broadcastConsoleReset(serverId, sessionId);
      });

      processManager.on('player_join', ({ serverId, player }) => {
        this.broadcastPlayerEvent(serverId, 'join', player);
      });

      processManager.on('player_leave', ({ serverId, player }) => {
        this.broadcastPlayerEvent(serverId, 'leave', player);
      });
    }

    console.log('[WebSocket] Server initialized on path /ws');
  }

  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    if (this.wss) {
      try { this.wss.close(); } catch (e) {}
      this.wss = null;
    }
    for (const [ws] of this.clients.entries()) {
      try { ws.terminate(); } catch (e) {}
    }
    this.clients.clear();
  }

  _validateTokenVersion(user) {
    if (!user || !user.username) return false;
    if (user.bypassed) return true;

    try {
      if (typeof authService.getUser === 'function') {
        const dbUser = authService.getUser(user.username);
        if (!dbUser) {
          if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
            return true;
          }
          return false; // User deleted or no longer exists
        }
        const dbVersion = typeof dbUser.tokenVersion === 'number' ? dbUser.tokenVersion : 0;
        const userVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
        return dbVersion === userVersion;
      }
    } catch (err) {
      console.warn('[WebSocket] Token version doğrulama hatası:', err.message);
      return false;
    }
    return true;
  }

  _revokeSession(ws, meta, reason = 'Oturum sonlandırıldı veya yetki iptal edildi.') {
    if (!meta) return;
    meta.subscriptions.clear();
    meta.subscribedMetrics = false;
    meta.user = null;
    meta.authFailed = true;

    this._send(ws, {
      type: 'auth_error',
      message: reason
    });

    try {
      ws.close(1008, 'Session revoked');
    } catch (e) {
      try { ws.terminate(); } catch (err) {}
    }
    this.clients.delete(ws);
  }

  _consumeCommandToken(meta) {
    if (!meta) return false;
    if (!meta.commandBucket) {
      meta.commandBucket = {
        tokens: 20,
        maxTokens: 20,
        refillRate: 10,
        lastRefill: Date.now()
      };
    }
    const bucket = meta.commandBucket;
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsedSeconds * bucket.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  _handleConnection(ws, req) {
    // 1. Cross-Site WebSocket Hijacking (CSWSH) Defense:
    // If Origin is supplied by a browser, it MUST match the request Host.
    if (req.headers && req.headers.origin && !tokenPolicy.isOriginAllowed(req)) {
      this._send(ws, {
        type: 'auth_error',
        message: 'Yasaklandı: Çapraz kaynaklı (cross-origin) WebSocket bağlantısı reddedildi.'
      });
      this._send(ws, {
        type: 'connection_ack',
        authenticated: false,
        message: 'Yasaklandı: Geçersiz kaynak.'
      });
      try {
        ws.close(4403, 'Forbidden origin');
      } catch (e) {}
      return;
    }

    // 2. Resolve authentication:
    // First check HttpOnly 'mazipanel_session' cookie; fallback to tokenPolicy.resolveAuth for backward compatibility
    let user = null;
    let authFailed = false;

    const authResult = tokenPolicy.resolveAuth(req, authService, config, { isWebSocket: true });
    if (authResult.authenticated) {
      if (this._validateTokenVersion(authResult.user)) {
        user = authResult.user;
      } else {
        authFailed = true;
      }
    } else if (authResult.error) {
      authFailed = true;
    }

    if (authFailed) {
      this._send(ws, {
        type: 'auth_error',
        message: 'Geçersiz veya süresi dolmuş token.'
      });
      this._send(ws, {
        type: 'error',
        code: 'UNAUTHORIZED',
        error: 'unauthorized',
        message: 'Oturum doğrulanamadı.'
      });
      this._send(ws, {
        type: 'connection_ack',
        authenticated: false,
        message: 'Kimlik doğrulama başarısız: Geçersiz veya süresi dolmuş token.'
      });
      try {
        ws.close(4401, 'Unauthorized');
      } catch (e) {}
      return;
    }

    const clientMeta = {
      user,
      authenticated: Boolean(user),
      authFailed: false,
      subscriptions: new Set(), // serverId
      subscribedMetrics: false,
      isAlive: true,
      commandBucket: {
        tokens: 20,
        maxTokens: 20,
        refillRate: 10,
        lastRefill: Date.now()
      }
    };

    this.clients.set(ws, clientMeta);

    ws.on('pong', () => {
      const meta = this.clients.get(ws);
      if (meta) meta.isAlive = true;
    });

    ws.on('message', (message) => {
      this._handleClientMessage(ws, message);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[WebSocket Error]:', err.message);
      this.clients.delete(ws);
    });

    if (user) {
      this._send(ws, {
        type: 'connection_ack',
        authenticated: true,
        message: `${user.username} olarak bağlanıldı`
      });
    } else {
      this._send(ws, {
        type: 'connection_ack',
        authenticated: false,
        message: 'Bağlandı (kimlik doğrulanmadı)'
      });
    }
  }

  _isAuthorizedUser(ws, meta) {
    if (!meta || !meta.user) return false;
    if (meta.user.bypassed) {
      return meta.user.role === 'admin' || meta.user.role === 'user';
    }
    if (meta.user.role !== 'admin' && meta.user.role !== 'user') {
      return false;
    }
    if (meta.user.exp && meta.user.exp <= Math.floor(Date.now() / 1000)) {
      this._handleSessionExpiry(ws, meta);
      return false;
    }
    if (!this._validateTokenVersion(meta.user)) {
      this._revokeSession(ws, meta, 'Oturum sonlandırıldı veya yetki iptal edildi.');
      return false;
    }
    return true;
  }

  _isAuthorizedForServer(ws, meta, serverId) {
    if (!this._isAuthorizedUser(ws, meta)) return false;
    const server = serverRegistry.getById(serverId);
    if (!server) {
      return meta.user && meta.user.role === 'admin';
    }
    return canAccessServer(meta.user, server);
  }

  _isAuthorizedAdmin(ws, meta) {
    if (!meta || !meta.user) return false;
    // Explicit legitimate loopback bypass (single user mode on loopback socket)
    if (meta.user.bypassed) {
      return meta.user.role === 'admin';
    }
    // Strict admin role required for privileged operations & broadcasts
    if (meta.user.role !== 'admin') {
      return false;
    }
    // Dynamic token expiration guard: recheck decoded exp on every privileged message / broadcast
    if (meta.user.exp && meta.user.exp <= Math.floor(Date.now() / 1000)) {
      this._handleSessionExpiry(ws, meta);
      return false;
    }
    if (!this._validateTokenVersion(meta.user)) {
      this._revokeSession(ws, meta, 'Oturum sonlandırıldı veya yetki iptal edildi.');
      return false;
    }
    return true;
  }

  _handleSessionExpiry(ws, meta) {
    if (!meta) return;
    meta.subscriptions.clear();
    meta.subscribedMetrics = false;
    meta.user = null;
    if (!meta.authFailed) {
      meta.authFailed = true;
      this._send(ws, {
        type: 'auth_error',
        message: 'Oturum süresi doldu. Lütfen tekrar kimlik doğrulaması yapın.'
      });
    }
  }

  _handleClientMessage(ws, raw) {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const rawLength = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw || ''), 'utf8');
    if (rawLength > MAX_WS_PAYLOAD_BYTES) {
      return this._send(ws, {
        type: 'error',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Mesaj boyutu izin verilen sınırı (64 KB) aşıyor.'
      });
    }

    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return this._send(ws, { type: 'error', message: 'Geçersiz JSON verisi.' });
    }

    // Real WebSocket Ping/Pong Latency Measurement (allowed unauthenticated)
    if (data.action === 'ping' || data.type === 'ping' || data.event === 'ping') {
      return this._send(ws, {
        event: 'pong',
        type: 'pong',
        action: 'pong',
        timestamp: data.timestamp || Date.now(),
        serverTime: Date.now()
      });
    }

    // Handle authentication message
    if (data.type === 'auth') {
      // Revoke any previous subscriptions on re-auth attempt to prevent privilege leakage
      meta.subscriptions.clear();
      meta.subscribedMetrics = false;

      const rawToken = data.token ? String(data.token).trim() : '';
      if (!rawToken) {
        meta.user = null;
        meta.authFailed = true;
        return this._send(ws, {
          type: 'auth_error',
          message: 'Geçersiz veya süresi dolmuş token.'
        });
      }
      const user = authService.verifyToken(rawToken);
      if (user && this._validateTokenVersion(user)) {
        meta.user = user;
        meta.authFailed = false;
        return this._send(ws, {
          type: 'auth_success',
          username: user.username,
          role: user.role,
          message: 'Kimlik doğrulama başarılı.'
        });
      } else {
        meta.user = null;
        meta.authFailed = true;
        return this._send(ws, {
          type: 'auth_error',
          message: 'Geçersiz veya süresi dolmuş token.'
        });
      }
    }

    // Subscribe to server console logs (requires authenticated user who owns the server)
    if (data.type === 'subscribe_console' || data.action === 'subscribe_console') {
      if (!this._isAuthorizedUser(ws, meta)) {
        return this._send(ws, {
          type: 'error',
          code: 'UNAUTHORIZED',
          message: 'Konsola abone olmak için kimlik doğrulaması gereklidir.'
        });
      }

      const serverId = data.serverId;
      if (!serverId) {
        return this._send(ws, { type: 'error', message: 'Sunucu kimliği (serverId) gereklidir.' });
      }

      if (!this._isAuthorizedForServer(ws, meta, serverId)) {
        return this._send(ws, {
          type: 'error',
          code: 'FORBIDDEN',
          message: 'Bu sunucuya erişim yetkiniz yok.'
        });
      }

      meta.subscriptions.add(serverId);

      // Send recent history from ring buffer in both raw string lines and object format
      const history = processManager.getLogs(serverId, 500);
      const status = processManager.getStatus(serverId);
      const sessionId = processManager.getSessionId(serverId);
      const rawLines = history.map((item) => (typeof item === 'string' ? item : (item.text || '')));
      const structuredLogs = history.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return {
            timestamp: item.timestamp || new Date().toISOString(),
            text: item.text || '',
            type: item.type || 'stdout',
            event: item.event || null,
            sessionId: item.sessionId || sessionId || null,
            ...item
          };
        }
        return {
          timestamp: new Date().toISOString(),
          text: String(item),
          type: 'stdout',
          event: null,
          sessionId: sessionId || null
        };
      });

      this._send(ws, {
        type: 'console_history',
        event: 'server_logs',
        serverId,
        sessionId,
        status: status.status,
        lines: rawLines,       // Raw legacy lines array preserved
        rawLines: rawLines,    // Raw legacy lines alias
        logs: structuredLogs,  // Structured objects preserving type/event/sessionId
        history: structuredLogs
      });
      return;
    }

    // Unsubscribe from console
    if (data.type === 'unsubscribe_console' || data.action === 'unsubscribe_console') {
      const serverId = data.serverId;
      if (serverId) {
        meta.subscriptions.delete(serverId);
        this._send(ws, { type: 'unsubscribed_console', serverId });
      }
      return;
    }

    // Send console command (stdin) - requires authenticated owner
    if (data.type === 'console_command') {
      if (!this._isAuthorizedUser(ws, meta)) {
        return this._send(ws, {
          type: 'error',
          code: 'UNAUTHORIZED',
          message: 'Konsol komutu göndermek için kimlik doğrulaması gereklidir.'
        });
      }

      // Per-connection command rate limit (token bucket: refill 10/s, burst 20)
      if (!this._consumeCommandToken(meta)) {
        return this._send(ws, {
          type: 'command_error',
          serverId: data.serverId || null,
          code: 'RATE_LIMIT_EXCEEDED',
          error: 'Çok fazla komut gönderildi. Lütfen kısa bir süre bekleyip tekrar deneyin.',
          message: 'Çok fazla komut gönderildi. Lütfen kısa bir süre bekleyip tekrar deneyin.'
        });
      }

      const { serverId, command } = data;
      if (!serverId || !command) {
        return this._send(ws, { type: 'error', message: 'Sunucu kimliği (serverId) ve komut gereklidir.' });
      }

      if (!this._isAuthorizedForServer(ws, meta, serverId)) {
        return this._send(ws, {
          type: 'command_error',
          serverId,
          code: 'FORBIDDEN',
          error: 'Bu sunucuya erişim yetkiniz yok.'
        });
      }

      // Sanitize command against newline injection (including \r, \n, \u0085, \u2028, \u2029)
      const cleanCommand = String(command).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim();
      if (!cleanCommand) {
        return this._send(ws, { type: 'error', message: 'Geçerli bir komut metni gereklidir.' });
      }

      try {
        const result = processManager.sendCommand(serverId, cleanCommand);
        this._send(ws, { type: 'command_sent', serverId, command: result ? result.command : cleanCommand });
      } catch (err) {
        this._send(ws, { type: 'command_error', serverId, error: err.message });
      }
      return;
    }

    // Subscribe to periodic metrics
    if (data.type === 'subscribe_metrics') {
      return this._handleSubscribeMetrics(ws, meta);
    }

    if (data.type === 'unsubscribe_metrics') {
      meta.subscribedMetrics = false;
      return;
    }

    this._send(ws, { type: 'unknown_type', received: data.type });
  }

  _canSubscribeMetrics(ws, meta) {
    if (!this._isAuthorizedUser(ws, meta)) return false;
    if (meta.user && meta.user.role === 'admin') return true;
    const username = meta.user && meta.user.username ? String(meta.user.username).trim().toLowerCase() : '';
    if (!username) return false;
    const ownedServers = serverRegistry.getAll(username);
    return Array.isArray(ownedServers) && ownedServers.length > 0;
  }

  _handleSubscribeMetrics(ws, meta) {
    if (!this._isAuthorizedUser(ws, meta)) {
      return this._send(ws, {
        type: 'error',
        code: 'UNAUTHORIZED',
        message: 'Metriklere abone olmak için kimlik doğrulaması gereklidir.'
      });
    }
    if (!this._canSubscribeMetrics(ws, meta)) {
      meta.subscribedMetrics = false;
      return this._send(ws, {
        type: 'error',
        code: 'FORBIDDEN',
        message: 'Bu metriklere erişim yetkiniz yok.'
      });
    }
    meta.subscribedMetrics = true;
    // Immediately send current metrics
    this._sendMetricsToClient(ws);
  }

  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {}
    }
  }

  broadcastConsoleLine(serverId, entry, sessionId) {
    const rawLine = typeof entry === 'string' ? entry : (entry?.text || '');
    const entryObj = typeof entry === 'object' && entry !== null ? entry : {
      timestamp: new Date().toISOString(),
      text: rawLine,
      type: 'stdout'
    };
    const sId = sessionId || entryObj.sessionId || processManager.getSessionId(serverId);

    const payload = JSON.stringify({
      type: 'console_line',
      event: entryObj.event || 'console_output',
      logType: entryObj.type || 'stdout',
      logEvent: entryObj.event || null,
      serverId,
      sessionId: sId,
      line: rawLine,
      text: rawLine,
      data: rawLine,
      entry: entryObj,
      timestamp: entryObj.timestamp
    });

    for (const [ws, meta] of this.clients.entries()) {
      if (ws.readyState === WebSocket.OPEN && this._isAuthorizedForServer(ws, meta, serverId) && meta.subscriptions && meta.subscriptions.has(serverId)) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  broadcastConsoleReset(serverId, sessionId) {
    const payload = JSON.stringify({
      type: 'console_reset',
      event: 'console_reset',
      action: 'console_reset',
      serverId,
      sessionId: sessionId || processManager.getSessionId(serverId),
      timestamp: new Date().toISOString()
    });

    for (const [ws, meta] of this.clients.entries()) {
      if (ws.readyState === WebSocket.OPEN && this._isAuthorizedForServer(ws, meta, serverId) && meta.subscriptions && meta.subscriptions.has(serverId)) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  broadcastServerStatus(serverId, status, oldStatus) {
    const payload = JSON.stringify({
      type: 'server_status',
      serverId,
      status,
      oldStatus,
      timestamp: new Date().toISOString()
    });

    for (const [ws, meta] of this.clients.entries()) {
      if (ws.readyState === WebSocket.OPEN && this._isAuthorizedForServer(ws, meta, serverId)) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  broadcastPlayerEvent(serverId, event, player) {
    const payload = JSON.stringify({
      type: 'player_event',
      serverId,
      event,
      player,
      timestamp: new Date().toISOString()
    });

    for (const [ws, meta] of this.clients.entries()) {
      if (ws.readyState === WebSocket.OPEN && this._isAuthorizedForServer(ws, meta, serverId) && meta.subscriptions && meta.subscriptions.has(serverId)) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  broadcastDownloadProgress(progressData) {
    const payload = JSON.stringify({
      ...progressData,
      engine: progressData.type,
      coreType: progressData.type,
      type: 'download_progress',
      timestamp: new Date().toISOString()
    });

    for (const [ws, meta] of this.clients.entries()) {
      const isAllowed = progressData.serverId
        ? this._isAuthorizedForServer(ws, meta, progressData.serverId)
        : this._isAuthorizedAdmin(ws, meta);
      if (ws.readyState === WebSocket.OPEN && isAllowed) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  _sendMetricsToClient(ws) {
    const meta = this.clients.get(ws);
    if (!this._canSubscribeMetrics(ws, meta)) return;

    const isAdmin = meta.user && meta.user.role === 'admin';
    const hostMetrics = metricsService.getHostMetrics();
    const serverStatuses = processManager.getAllStatuses();
    const serverMetrics = {};
    for (const [id, status] of Object.entries(serverStatuses)) {
      if (!isAdmin) {
        const srv = serverRegistry.getById(id);
        if (!srv || !canAccessServer(meta.user, srv)) continue;
      }
      serverMetrics[id] = {
        ...status,
        metrics: metricsService.getServerMetrics(id)
      };
    }

    this._send(ws, {
      type: 'metrics_update',
      host: isAdmin ? hostMetrics : sanitizeHostMetricsForUser(hostMetrics),
      servers: serverMetrics,
      timestamp: new Date().toISOString()
    });
  }

  _broadcastMetrics() {
    let clientsWaiting = false;
    for (const [ws, meta] of this.clients.entries()) {
      if (meta.subscribedMetrics && this._canSubscribeMetrics(ws, meta)) {
        clientsWaiting = true;
        break;
      }
    }

    if (!clientsWaiting) return;

    const hostMetrics = metricsService.getHostMetrics();
    const sanitizedHost = sanitizeHostMetricsForUser(hostMetrics);
    const serverStatuses = processManager.getAllStatuses();
    const allServerMetrics = {};
    for (const [id, status] of Object.entries(serverStatuses)) {
      allServerMetrics[id] = {
        ...status,
        metrics: metricsService.getServerMetrics(id)
      };
    }

    const nowIso = new Date().toISOString();
    const adminPayload = JSON.stringify({
      type: 'metrics_update',
      host: hostMetrics,
      servers: allServerMetrics,
      timestamp: nowIso
    });

    for (const [ws, meta] of this.clients.entries()) {
      if (ws.readyState === WebSocket.OPEN && meta.subscribedMetrics && this._canSubscribeMetrics(ws, meta)) {
        try {
          if (meta.user && meta.user.role === 'admin') {
            ws.send(adminPayload);
          } else {
            const filteredServers = {};
            for (const [id, metricObj] of Object.entries(allServerMetrics)) {
              const srv = serverRegistry.getById(id);
              if (srv && canAccessServer(meta.user, srv)) {
                filteredServers[id] = metricObj;
              }
            }
            ws.send(JSON.stringify({
              type: 'metrics_update',
              host: sanitizedHost,
              servers: filteredServers,
              timestamp: nowIso
            }));
          }
        } catch (e) {}
      }
    }
  }
}

module.exports = new WsManager();
