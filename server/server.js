const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const config = require('./config');
const authController = require('./src/auth/authController');
const authMiddleware = require('./src/auth/authMiddleware');
const serversController = require('./src/servers/serversController');
const backupsController = require('./src/servers/backupsController');
const metricsController = require('./src/metrics/metricsController');
const integrationsController = require('./src/integrations/integrationsController');
const p2pController = require('./src/p2p/p2pController');
const wsManager = require('./src/websocket/wsManager');
const javaDetector = require('./src/system/javaDetector');
const processManager = require('./src/servers/processManager');

const app = express();
const server = http.createServer(app);

// Disable X-Powered-By header
app.disable('x-powered-by');

// Trust reverse proxy if explicitly configured
if (config.TRUST_PROXY) {
  app.set('trust proxy', true);
}

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://mc-heads.net; connect-src 'self' ws: wss:; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

// Hardened CORS configuration (restricts cross-origin requests; allows same-origin and trusted origins)
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const lowerOrigin = origin.toLowerCase();
    const trusted = Array.isArray(config.TRUSTED_ORIGINS) ? config.TRUSTED_ORIGINS : [];
    if (trusted.includes(lowerOrigin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

// Global standard body limits (hardened to 1mb); /files/content is skipped here and parsed with 50mb AFTER authMiddleware inside serversController
const jsonParser1mb = express.json({ limit: '1mb' });
const urlencodedParser1mb = express.urlencoded({ extended: true, limit: '1mb' });
app.use((req, res, next) => {
  if (req.path.includes('/files/content')) {
    return next();
  }
  jsonParser1mb(req, res, (err) => {
    if (err) return next(err);
    urlencodedParser1mb(req, res, next);
  });
});

// Request logging in development/debug
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.originalUrl.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'maziPanel Backend Daemon',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Mount API Controllers
app.use('/api/auth', authController);
app.use('/api/servers', serversController);
app.use('/api/backups', backupsController);
app.use('/api/metrics', metricsController);
app.use('/api/integrations', authMiddleware, integrationsController);
app.use('/api/p2p', p2pController);

// Serve static frontend from client/dist
app.use(express.static(config.CLIENT_DIST_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath && filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// SPA fallback or status landing page
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }

  const indexHtml = path.join(config.CLIENT_DIST_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(indexHtml);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>maziPanel Backend Daemon Active</title>
  <style>
    body {
      background-color: #0d1117;
      color: #c9d1d9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background-color: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 32px;
      max-width: 600px;
      width: 90%;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    h1 { color: #58a6ff; margin-top: 0; font-size: 24px; display: flex; align-items: center; gap: 10px; }
    .status-badge { background: #238636; color: #fff; padding: 4px 10px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    p { line-height: 1.6; color: #8b949e; }
    ul { list-style: none; padding-left: 0; }
    li { padding: 8px 0; border-bottom: 1px solid #21262d; font-family: monospace; font-size: 14px; }
    li strong { color: #79c0ff; }
    .footer { margin-top: 20px; font-size: 12px; color: #484f58; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>maziPanel Daemon <span class="status-badge">ONLINE</span></h1>
    <p>maziPanel API Motoru ve WebSocket Servisi <strong>Port ${config.PORT}</strong> üzerinde aktif olarak çalışıyor.</p>
    <ul>
      <li><strong>API Health:</strong> GET /api/health</li>
      <li><strong>Auth Status:</strong> GET /api/auth/status</li>
      <li><strong>Master Setup:</strong> POST /api/auth/setup</li>
      <li><strong>Auth Login:</strong> POST /api/auth/login</li>
      <li><strong>Servers API:</strong> /api/servers</li>
      <li><strong>Metrics API:</strong> /api/metrics/host</li>
      <li><strong>Integrations API:</strong> /api/integrations</li>
      <li><strong>WebSocket:</strong> ws://&lt;host&gt;:${config.PORT}/ws</li>
    </ul>
    <div class="footer">Frontend <code>/mazideveloper/client/dist</code> derlendiğinde otomatik olarak burada sunulacaktır.</div>
  </div>
</body>
</html>`);
});

// Global Error handling middleware (sanitizes 500 errors and protects internal server paths)
app.use((err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  console.error('[maziPanel Error]:', err);

  if (statusCode < 500 || err.expose === true) {
    return res.status(statusCode).json({
      error: err.message || 'İşlem gerçekleştirilemedi.'
    });
  }

  return res.status(500).json({
    error: 'Sunucuda beklenmeyen bir hata oluştu.'
  });
});

// Initialize WebSocket Server
wsManager.initialize(server);

// Initial Java discovery
console.log('[maziPanel] Detecting Java installations...');
const detectedJavas = javaDetector.detectJavaInstallations(true);
console.log(`[maziPanel] Found ${detectedJavas.length} Java installation(s):`);
detectedJavas.forEach((j) => console.log(`  - [Java ${j.majorVersion || j.rawVersion}] ${j.vendor}: ${j.path}`));

// Start HTTP & WebSocket Server
server.listen(config.PORT, config.HOST, () => {
  console.log(`====================================================`);
  console.log(`  maziPanel Daemon & API Engine`);
  console.log(`  Listening on: http://${config.HOST}:${config.PORT}`);
  console.log(`  WebSocket on: ws://${config.HOST}:${config.PORT}/ws`);
  console.log(`  Base Directory: ${config.BASE_DIR}`);
  console.log(`====================================================`);

  // Recover already-running Minecraft servers first, then auto-start eligible servers on boot
  (async () => {
    try {
      const recoveredCount = await processManager.recoverRunningServers();
      if (recoveredCount > 0) {
        console.log(`[maziPanel Boot] ${recoveredCount} aktif Minecraft sunucusu kesintisiz devralındı.`);
      }

      const serverRegistry = require('./src/servers/serverRegistry');
      const servers = serverRegistry.getAll();
      const toStart = servers.filter((s) => {
        if (processManager.isRunning(s.id)) return false;
        const settings = serverRegistry.getServerSettings(s);
        const policy = settings.autoStartOnBoot || 'last_state';
        if (policy === 'always') return true;
        if (policy === 'last_state' && s.lastRunning === true) return true;
        return false;
      });

      if (toStart.length > 0) {
        console.log(`[maziPanel Boot] Otomatik başlatılacak ${toStart.length} sunucu bulundu.`);
        for (const s of toStart) {
          try {
            console.log(`[maziPanel Boot] Sunucu başlatılıyor: ${s.name} (${s.id})`);
            await processManager.startServer(s.id);
          } catch (startErr) {
            console.error(`[maziPanel Boot] ${s.id} başlatılamadı:`, startErr.message);
          }
          // Delay 3 seconds between servers
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    } catch (bootErr) {
      console.error('[maziPanel Boot] Otomatik başlatma hatası:', bootErr.message);
    }
  })();
});

// Graceful shutdown / panel restart handler
let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const stopServersOnExit =
    process.env.TEST_MODE === 'true' ||
    process.env.SHUTDOWN_SERVERS_ON_EXIT === 'true';

  if (stopServersOnExit) {
    console.log('[maziPanel] Servis durduruluyor, açık Minecraft sunucuları düzgün kapatılıyor...');
    try {
      await processManager.gracefulShutdownAll();
    } catch (e) {
      console.error('[maziPanel] Sunucuları kapatırken hata:', e.message);
    }
  } else {
    console.log('[maziPanel] Panel servisi yeniden başlatılıyor/durduruluyor; açık Minecraft sunucuları kesintisiz korunuyor...');
    try {
      await processManager.detachAll();
    } catch (e) {
      console.error('[maziPanel] Sunucu köprü bağlantıları ayrılırken hata:', e.message);
    }
  }

  try {
    const metricsService = require('./src/metrics/metricsService');
    metricsService.flushAndSaveStats();
  } catch (e) {}

  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (e) {}

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
