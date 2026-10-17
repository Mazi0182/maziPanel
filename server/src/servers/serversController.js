const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const config = require('../../config');
const authMiddleware = require('../auth/authMiddleware');
const serverRegistry = require('./serverRegistry');
const processManager = require('./processManager');
const zipImporter = require('./zipImporter');
const fileManager = require('./fileManager');
const playerManager = require('./playerManager');
const javaDetector = require('../system/javaDetector');
const javaInstaller = require('../system/javaInstaller');
const javaCompatibility = require('../system/javaCompatibility');
const jarDownloader = require('./jarDownloader');
const backupManager = require('./backupManager');
const net = require('net');

// Helper: read actual configured maxPlayers from server.properties without overwriting server config
function readActualMaxPlayers(server) {
  if (!server) return 10;
  try {
    const propsPath = path.join(server.directory, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const content = fs.readFileSync(propsPath, 'utf8');
      const match = content.match(/^max-players\s*=\s*(\d+)/m);
      if (match) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }
  } catch (e) {}
  if (typeof server.maxPlayers === 'number' && !isNaN(server.maxPlayers)) {
    return server.maxPlayers;
  }
  return 10;
}

// Helper: check if a port is available to bind
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.once('close', () => resolve(true)).close();
      })
      .listen(port, '0.0.0.0');
  });
}

// Helper: format RAM strings safely (e.g. 4 -> "4G", "4GB" -> "4G", "4096M" -> "4096M")
function formatRam(ram, fallback = '2G') {
  if (ram === undefined || ram === null || ram === '') return fallback;
  let str = String(ram).trim().replace(/\s+/g, '');
  str = str.replace(/([gmk])b$/i, '$1');
  if (/^\d+$/.test(str)) return `${str}G`;
  if (/^\d+[gmkGMK]$/.test(str)) return str.toUpperCase();
  return fallback;
}

// Helper: find next available port
async function getAvailablePort(preferredPort = 25565) {
  const servers = serverRegistry.getAll();
  const registeredPorts = new Set(
    servers.map((s) => parseInt(s.port, 10)).filter((p) => !isNaN(p) && p > 0)
  );
  registeredPorts.add(25566); // Reserve P2P Tunnel UDP port
  let port = parseInt(preferredPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    port = 25565;
  }
  let attempts = 0;
  while ((registeredPorts.has(port) || !(await checkPortAvailable(port))) && attempts < 1000) {
    port++;
    if (port > 65535) port = 1024;
    attempts++;
  }
  return port;
}

// Helper: resolve best Java runtime
function resolveJavaExecutable(requestedPath, mcVersion, coreType = 'paper', mojangMeta = null) {
  const req = javaCompatibility.getJavaRequirements(coreType, mcVersion, mojangMeta);
  return javaDetector.getJavaForServer(requestedPath, {
    coreType,
    version: mcVersion,
    ...req
  });
}

// Helper: RFC 5987 / RFC 6266 Content-Disposition header with filename*
function formatContentDisposition(filename) {
  const base = path.basename(filename || 'download');
  const asciiFallback = base.replace(/["\\]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(base).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// In-memory sliding rate limiter for endpoints prone to abuse
class SimpleRateLimiter {
  constructor(windowMs, maxHits) {
    this.windowMs = windowMs;
    this.maxHits = maxHits;
    this.hits = new Map();
    const timer = setInterval(() => this.prune(), 60000);
    if (timer.unref) timer.unref();
  }

  isLimited(key) {
    const now = Date.now();
    let records = this.hits.get(key);
    if (!records) {
      records = [];
      this.hits.set(key, records);
    }
    const cutoff = now - this.windowMs;
    while (records.length > 0 && records[0] <= cutoff) {
      records.shift();
    }
    if (records.length >= this.maxHits) {
      return true;
    }
    records.push(now);
    return false;
  }

  prune() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, records] of this.hits.entries()) {
      while (records.length > 0 && records[0] <= cutoff) {
        records.shift();
      }
      if (records.length === 0) {
        this.hits.delete(key);
      }
    }
  }
}

const checkPortRateLimiter = new SimpleRateLimiter(10000, 30); // 30 checks per 10s
const commandRateLimiter = new SimpleRateLimiter(5000, 15); // 15 commands per 5s

// Setup multer for ZIP imports and file uploads
const upload = multer({
  dest: config.TEMP_DIR,
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB max upload
  }
});

// Cleanup temporary files created by multer if upload failed or was aborted
function cleanupMulterFiles(req) {
  try {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (req.files) {
      const list = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
      for (const f of list) {
        if (f && f.path && fs.existsSync(f.path)) {
          try { fs.unlinkSync(f.path); } catch (e) {}
        }
      }
    }
  } catch (e) {}
}

// Middleware to clean up partial/uploaded temp files if client connection drops before completion
function attachUploadCleanup(req, res, next) {
  res.on('close', () => {
    if (!res.writableEnded) {
      cleanupMulterFiles(req);
    }
  });
  next();
}

// Protect all routes with JWT auth
router.use(authMiddleware);

// Centralized ownership and access helper
function canAccessServer(user, server) {
  if (!user || !server) return false;
  if (user.role === 'admin') return true;
  const userNorm = (user.username || '').trim().toLowerCase();
  const ownerNorm = (server.owner || '').trim().toLowerCase();
  return Boolean(userNorm && userNorm === ownerNorm);
}

// Multi-tenant server ownership isolation middleware
router.param('id', (req, res, next, id) => {
  // Allow public server icon requests
  const cleanPath = (req.originalUrl || req.url || '').split('?')[0];
  const isIcon = (req.method === 'GET' || req.method === 'HEAD') && cleanPath.endsWith('/icon');
  if (isIcon) {
    return next();
  }

  const server = serverRegistry.getById(id);
  if (!server) {
    return res.status(404).json({ error: 'Sunucu bulunamadı.' });
  }

  if (!canAccessServer(req.user, server)) {
    return res.status(403).json({ error: 'Bu sunucuya erişim yetkiniz yok.' });
  }

  req.server = server;
  next();
});

// --- Java Detection & Dynamic Catalog ---
router.get('/system/java', (req, res) => {
  try {
    const list = javaDetector.detectJavaInstallations(true);
    const isAdmin = Boolean(req.user && req.user.role === 'admin');
    res.json(isAdmin ? list : javaDetector.sanitizeJavaList(list));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/system/java/catalog', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    const allowedArchs = ['linux-x64', 'linux-aarch64'];
    const requestedArch = req.query.arch ? String(req.query.arch).trim().toLowerCase() : null;
    const targetArch = allowedArchs.includes(requestedArch) ? requestedArch : null;

    const catalogData = await javaInstaller.getJavaCatalog({ forceRefresh, targetArch });
    const isAdmin = Boolean(req.user && req.user.role === 'admin');
    if (!isAdmin && Array.isArray(catalogData?.installed)) {
      catalogData.installed = javaDetector.sanitizeJavaList(catalogData.installed);
    }
    res.json({
      success: true,
      ...catalogData
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Java kataloğu alınamadı.' });
  }
});

router.get('/system/java/install/status', (req, res) => {
  try {
    const active = javaInstaller.getActiveInstalls();
    res.json({
      success: true,
      activeInstalls: active
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/system/java/install', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const rawMajor = req.body.majorVersion !== undefined ? req.body.majorVersion : req.body.version;
    const majorVersion = javaInstaller.parseStrictMajorVersion(rawMajor);
    if (!majorVersion) {
      return res.status(400).json({
        error: 'Geçersiz veya eksik Java ana sürümü belirtildi. Tam sayı (8 - 99) olmalıdır. Örn: { "majorVersion": 27 }'
      });
    }

    if (javaInstaller.isInstalling(majorVersion)) {
      return res.status(409).json({
        error: `Java ${majorVersion} kurulumu zaten devam ediyor.`
      });
    }

    const result = await javaInstaller.installJavaVersion(majorVersion);
    res.json({
      success: true,
      message: `Java ${majorVersion} başarıyla kuruldu.`,
      path: result.path,
      installedInfo: result.installedInfo
    });
  } catch (err) {
    const isConflict = err.message && err.message.includes('zaten devam ediyor');
    res.status(isConflict ? 409 : 500).json({ error: err.message || 'Java kurulumu başarısız oldu.' });
  }
});

// --- Java Requirements Endpoint ---
router.get('/system/java/requirements', async (req, res) => {
  try {
    const core = (req.query.core || 'paper').toLowerCase().trim();
    const version = req.query.version;
    if (!version) {
      return res.status(400).json({ error: 'version parametresi gereklidir.' });
    }
    let mojangMeta = null;
    if (core === 'vanilla') {
      mojangMeta = await javaCompatibility.fetchMojangJavaMetadata(version);
    }
    const requirements = javaCompatibility.getJavaRequirements(core, version, mojangMeta);
    res.json({
      success: true,
      core,
      version,
      ...requirements
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Cores & Dynamic Versions ---
router.get('/cores/versions', async (req, res) => {
  try {
    const type = (req.query.type || 'purpur').toLowerCase().trim();
    const versions = await jarDownloader.getVersions(type);
    res.json({
      type,
      core: type,
      count: versions.length,
      versions
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Port Availability Check ---
router.get('/check-port', async (req, res) => {
  try {
    const clientKey = (req.user && req.user.username) ? req.user.username : (req.ip || 'ip');
    if (checkPortRateLimiter.isLimited(clientKey)) {
      return res.status(429).json({ error: 'Çok fazla port kontrol isteği gönderildi. Lütfen biraz bekleyin.' });
    }

    const rawPort = req.query.port;
    if (!rawPort) {
      return res.status(400).json({ error: 'Port parametresi zorunludur.' });
    }
    const port = parseInt(rawPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      return res.status(400).json({
        port: rawPort,
        available: false,
        inUse: false,
        error: 'Geçersiz port numarası. Port 1024 ile 65535 arasında olmalıdır.'
      });
    }

    const excludeServerId = req.query.excludeServerId;
    const servers = serverRegistry.getAll();
    const registeredConflict = servers.some(
      (s) => parseInt(s.port, 10) === port && (!excludeServerId || s.id !== excludeServerId)
    );

    if (registeredConflict) {
      return res.json({
        port,
        available: false,
        inUse: true,
        reason: 'Port kullanımda.'
      });
    }

    const isSystemFree = await checkPortAvailable(port);
    const available = Boolean(isSystemFree);
    return res.json({
      port,
      available,
      inUse: !available,
      reason: available ? 'Port kullanılabilir.' : 'Port kullanımda.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Server Creation with Core Jar Download ---
const handleCreateServerWithCore = async (req, res) => {
  try {
    const {
      name,
      type = 'purpur',
      version,
      port,
      ramMin = '2G',
      ramMax = '4G',
      javaPath,
      difficulty = 'normal',
      viewDistance = 10,
      simulationDistance = 10,
      onlineMode = true
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Sunucu adı metin formatında olmalı ve boş bırakılmamalıdır.' });
    }

    if (/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/.test(name)) {
      return res.status(400).json({ error: 'Sunucu adı satır sonu veya geçersiz kontrol karakterleri içeremez.' });
    }

    const cleanType = (type || 'purpur').toLowerCase().trim();
    if (!['purpur', 'paper', 'vanilla'].includes(cleanType)) {
      return res.status(400).json({
        error: `Desteklenmeyen çekirdek türü: "${type}". Desteklenen türler: purpur, paper, vanilla`
      });
    }

    // Validate difficulty (peaceful, easy, normal, hard - default: normal)
    const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
    const cleanDifficulty = (difficulty && typeof difficulty === 'string' && validDifficulties.includes(difficulty.toLowerCase().trim()))
      ? difficulty.toLowerCase().trim()
      : 'normal';

    // Validate view-distance (2-32, default: 10)
    let finalViewDistance = 10;
    const parsedVD = parseInt(viewDistance, 10);
    if (!isNaN(parsedVD)) {
      finalViewDistance = Math.max(2, Math.min(32, parsedVD));
    }

    // Validate simulation-distance (5-32, default: 10)
    let finalSimulationDistance = 10;
    const parsedSD = parseInt(simulationDistance, 10);
    if (!isNaN(parsedSD)) {
      finalSimulationDistance = Math.max(5, Math.min(32, parsedSD));
    }

    // Validate online-mode (boolean, default: true)
    let finalOnlineMode = true;
    if (onlineMode !== undefined) {
      finalOnlineMode = onlineMode === true || onlineMode === 'true';
    }

    // Resolve version if not provided or set to 'latest'
    let selectedVersion = version;
    if (!selectedVersion || selectedVersion === 'latest') {
      const availableVersions = await jarDownloader.getVersions(cleanType);
      selectedVersion = availableVersions[0];
    }

    // Generate unique ID and directory
    const isAdmin = Boolean(req.user && req.user.role === 'admin');
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'server';
    const rawId = req.body.id ? String(req.body.id).trim() : `${safeName}-${Date.now().toString(36)}`;
    let id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || `server-${Date.now().toString(36)}`;
    let serverDir = path.join(config.SERVERS_DIR, id);

    if (serverRegistry.getById(id) || fs.existsSync(serverDir)) {
      id = `${id}-${Math.random().toString(36).substring(2, 6)}`;
      serverDir = path.join(config.SERVERS_DIR, id);
    }

    id = serverRegistry.validateServerId(id);
    serverDir = serverRegistry.assertSafeServerDirectory(serverDir, id);

    // 4. Validate and resolve Java executable BEFORE creating directory/files
    let validatedJavaInput = '';
    try {
      validatedJavaInput = serverRegistry.validateJavaPath(javaPath, { isAdmin });
    } catch (javaValErr) {
      return res.status(400).json({ error: javaValErr.message });
    }

    let mojangMeta = null;
    if (cleanType === 'vanilla' && selectedVersion) {
      try {
        mojangMeta = await javaCompatibility.fetchMojangJavaMetadata(selectedVersion);
      } catch (e) {}
    }

    if (validatedJavaInput && validatedJavaInput !== 'auto' && (validatedJavaInput.includes('/') || validatedJavaInput.includes('\\'))) {
      const info = javaDetector.inspectJavaExecutable(validatedJavaInput);
      if (!info) {
        return res.status(400).json({
          error: `Belirtilen Java yolu bulunamadı veya geçerli bir Java çalıştırılabilir dosyası değil: "${validatedJavaInput}"`
        });
      }
      if (info.majorVersion && !javaCompatibility.isJavaCompatible(info.majorVersion, cleanType, selectedVersion, mojangMeta, true)) {
        const reqs = javaCompatibility.getJavaRequirements(cleanType, selectedVersion, mojangMeta);
        return res.status(400).json({
          error: `Seçilen Java sürümü (Java ${info.majorVersion}) ${cleanType} ${selectedVersion} için uyumsuzdur. En az Java ${reqs.minJava} gereklidir.`
        });
      }
    }

    let chosenJava;
    try {
      chosenJava = resolveJavaExecutable(validatedJavaInput, selectedVersion, cleanType, mojangMeta);
    } catch (javaErr) {
      return res.status(400).json({ error: javaErr.message });
    }

    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // 1. Write eula.txt (eula=true) atomically
    serverRegistry.atomicWriteFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    // 2. Determine and allocate port
    const finalPort = await getAvailablePort(port || 25565);

    // 3. Write or update server.properties atomically
    const propsPath = path.join(serverDir, 'server.properties');
    const safeMotd = name.trim().replace(/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/g, ' ');
    let propsContent = '';
    if (fs.existsSync(propsPath)) {
      propsContent = fs.readFileSync(propsPath, 'utf8');
      const updateProp = (content, key, val) => {
        const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
        if (regex.test(content)) {
          return content.replace(regex, `${key}=${val}`);
        } else {
          return content.trimEnd() + `\n${key}=${val}\n`;
        }
      };
      propsContent = updateProp(propsContent, 'server-port', finalPort);
      propsContent = updateProp(propsContent, 'query.port', finalPort);
      propsContent = updateProp(propsContent, 'motd', `${safeMotd} - Powered by maziPanel`);
      propsContent = updateProp(propsContent, 'online-mode', finalOnlineMode);
      propsContent = updateProp(propsContent, 'difficulty', cleanDifficulty);
      propsContent = updateProp(propsContent, 'view-distance', finalViewDistance);
      propsContent = updateProp(propsContent, 'simulation-distance', finalSimulationDistance);
    } else {
      propsContent = [
        '#Minecraft server properties',
        '#Created by maziPanel',
        `server-port=${finalPort}`,
        `query.port=${finalPort}`,
        `motd=${safeMotd} - Powered by maziPanel`,
        `online-mode=${finalOnlineMode}`,
        'max-players=10',
        `difficulty=${cleanDifficulty}`,
        'gamemode=survival',
        'pvp=true',
        'enable-command-block=false',
        'spawn-protection=16',
        `view-distance=${finalViewDistance}`,
        `simulation-distance=${finalSimulationDistance}`,
        'enable-rcon=false',
        'white-list=false'
      ].join('\n') + '\n';
    }
    serverRegistry.atomicWriteFileSync(propsPath, propsContent);

    // 5. Download the server jar
    const jarFileName = serverRegistry.validateJarFile(`${cleanType}.jar`);
    const jarDest = path.join(serverDir, jarFileName);
    await jarDownloader.downloadJar({
      serverId: id,
      type: cleanType,
      version: selectedVersion,
      destPath: jarDest
    });

    // 6. Format RAM flexibly (allow numbers, '2G', '4096M', etc.)
    const finalMinRam = formatRam(ramMin, '2G');
    const finalMaxRam = formatRam(ramMax, '4G');

    // 7. Register server
    const currentUsername = (req.user && req.user.username) ? req.user.username.trim().toLowerCase() : 'mazidev';
    const serverRecord = serverRegistry.register({
      id,
      name: name.trim(),
      owner: currentUsername,
      directory: serverDir,
      jarFile: jarFileName,
      javaPath: chosenJava,
      minRam: finalMinRam,
      maxRam: finalMaxRam,
      jvmFlags: '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
      port: finalPort,
      type: cleanType,
      version: selectedVersion,
      autoRestart: true,
      maxCrashRetries: 5,
      settings: {
        startup: {
          jarFile: jarFileName
        }
      }
    }, { isAdmin: true });

    // Return the created server object
    res.status(201).json(serverRecord);
  } catch (err) {
    console.error('[Sunucu Oluşturma Hatası]:', err);
    res.status(500).json({ error: err.message });
  }
};

router.post('/create', handleCreateServerWithCore);
router.post('/create-with-core', handleCreateServerWithCore);
router.get('/', (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const currentUsername = (req.user && req.user.username) ? req.user.username.trim().toLowerCase() : null;
    const servers = isAdmin ? serverRegistry.getAll() : serverRegistry.getAll(currentUsername);
    const result = servers.map((s) => {
      const hasCustomIcon = fs.existsSync(path.join(s.directory, 'server-icon.png')) ||
        fs.existsSync(path.join(s.directory, 'icon.png'));
      let icon = s.icon || s.iconUrl || null;
      let iconUrl = s.iconUrl || s.icon || null;
      if (hasCustomIcon) {
        const v = s.iconVersion || Date.now();
        icon = `/api/servers/${s.id}/icon?v=${v}`;
        iconUrl = icon;
      }
      const runtime = processManager.getStatus(s.id);
      const settings = serverRegistry.getServerSettings(s);
      const ramDisplay = serverRegistry.formatRamDisplay(s.maxRam);
      const actualMaxPlayers = readActualMaxPlayers(s);
      return {
        ...s,
        owner: s.owner || 'mazidev',
        maxPlayers: actualMaxPlayers,
        ...(icon ? { icon, iconUrl } : {}),
        settings,
        ramAllocated: ramDisplay,
        allocatedFormatted: ramDisplay,
        runtime: {
          ...runtime,
          maxPlayers: actualMaxPlayers
        }
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const data = { ...(req.body || {}) };
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      return res.status(400).json({ error: 'Sunucu adı metin formatında olmalı ve boş bırakılmamalıdır.' });
    }
    if (/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/.test(data.name)) {
      return res.status(400).json({ error: 'Sunucu adı satır sonu veya geçersiz kontrol karakterleri içeremez.' });
    }
    const isAdmin = Boolean(req.user && req.user.role === 'admin');
    const currentUsername = (req.user && req.user.username) ? req.user.username.trim().toLowerCase() : 'mazidev';
    if (!isAdmin) {
      delete data.directory;
      delete data.owner;
    }
    const server = serverRegistry.register({
      ...data,
      name: data.name.trim(),
      owner: (isAdmin && data.owner) ? String(data.owner).trim().toLowerCase() : currentUsername
    }, { isAdmin });
    res.status(201).json(server);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }
    const hasCustomIcon = fs.existsSync(path.join(server.directory, 'server-icon.png')) ||
      fs.existsSync(path.join(server.directory, 'icon.png'));
    let icon = server.icon || server.iconUrl || null;
    let iconUrl = server.iconUrl || server.icon || null;
    if (hasCustomIcon) {
      const v = server.iconVersion || Date.now();
      icon = `/api/servers/${server.id}/icon?v=${v}`;
      iconUrl = icon;
    }
    const runtime = processManager.getStatus(server.id);
    const settings = serverRegistry.getServerSettings(server);
    const ramDisplay = serverRegistry.formatRamDisplay(server.maxRam);
    const actualMaxPlayers = readActualMaxPlayers(server);
    res.json({
      ...server,
      maxPlayers: actualMaxPlayers,
      ...(icon ? { icon, iconUrl } : {}),
      settings,
      ramAllocated: ramDisplay,
      allocatedFormatted: ramDisplay,
      runtime: {
        ...runtime,
        maxPlayers: actualMaxPlayers
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };
    const isAdmin = Boolean(req.user && req.user.role === 'admin');

    delete updates.id;
    delete updates.directory;
    delete updates.createdAt;
    if (!isAdmin) {
      delete updates.owner;
    }

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || !updates.name.trim()) {
        return res.status(400).json({ error: 'Sunucu adı geçerli bir metin olmalıdır.' });
      }
      if (/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/.test(updates.name)) {
        return res.status(400).json({ error: 'Sunucu adı satır sonu veya geçersiz kontrol karakterleri içeremez.' });
      }
      updates.name = updates.name.trim();
    }
    if (updates.minRam !== undefined) updates.minRam = formatRam(updates.minRam, '2G');
    if (updates.maxRam !== undefined) updates.maxRam = formatRam(updates.maxRam, '4G');
    if (updates.port !== undefined) {
      const p = parseInt(updates.port, 10);
      if (isNaN(p) || p < 1024 || p > 65535) {
        return res.status(400).json({ error: 'Port 1024 ile 65535 arasında geçerli bir tam sayı olmalıdır.' });
      }
      const allServers = serverRegistry.getAll();
      const conflict = allServers.some((s) => s.id !== req.params.id && parseInt(s.port, 10) === p);
      if (conflict) {
        return res.status(400).json({ error: 'Bu port zaten başka bir sunucuya atanmış.' });
      }
      updates.port = p;
    }
    if (updates.jarFile !== undefined) {
      updates.jarFile = serverRegistry.validateJarFile(updates.jarFile);
    }
    if (updates.javaPath !== undefined) {
      updates.javaPath = serverRegistry.validateJavaPath(updates.javaPath, { isAdmin });
    }
    if (updates.jvmFlags !== undefined || updates.serverArgs !== undefined) {
      const startupArguments = require('./startupArguments');
      startupArguments.assertSafeStartupArguments(
        updates.jvmFlags || '',
        updates.serverArgs || '',
        { isAdmin }
      );
    }
    if (updates.javaPath && updates.javaPath !== 'auto') {
      const server = serverRegistry.getById(req.params.id);
      if (server) {
        const info = javaDetector.inspectJavaExecutable(updates.javaPath);
        let mojangMeta = null;
        if (server.type === 'vanilla') {
          mojangMeta = await javaCompatibility.fetchMojangJavaMetadata(server.version);
        }
        if (info && info.majorVersion && !javaCompatibility.isJavaCompatible(info.majorVersion, server.type, server.version, mojangMeta, true)) {
          const reqs = javaCompatibility.getJavaRequirements(server.type, server.version, mojangMeta);
          return res.status(400).json({
            error: `Seçilen Java sürümü (Java ${info.majorVersion}) ${server.type || 'Minecraft'} ${server.version || ''} için uyumsuzdur. En az Java ${reqs.minJava} gereklidir.`
          });
        }
      }
    }
    const updated = serverRegistry.update(req.params.id, updates, { isAdmin });
    res.json(updated);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.put('/:id/settings', async (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }

    const isAdmin = Boolean(req.user && req.user.role === 'admin');
    const explicitJava = req.body.startup?.javaPath || req.body.javaPath;
    if (explicitJava && explicitJava !== 'auto') {
      const validatedJava = serverRegistry.validateJavaPath(explicitJava, { isAdmin });
      const info = javaDetector.inspectJavaExecutable(validatedJava);
      let mojangMeta = null;
      if (server.type === 'vanilla') {
        mojangMeta = await javaCompatibility.fetchMojangJavaMetadata(server.version);
      }
      if (info && info.majorVersion && !javaCompatibility.isJavaCompatible(info.majorVersion, server.type, server.version, mojangMeta, true)) {
        const reqs = javaCompatibility.getJavaRequirements(server.type, server.version, mojangMeta);
        return res.status(400).json({
          error: `Seçilen Java sürümü (Java ${info.majorVersion}) ${server.type || 'Minecraft'} ${server.version || ''} için uyumsuzdur. En az Java ${reqs.minJava} gereklidir.`
        });
      }
    }

    const rawStartup = req.body.startup || {};
    const jvmFlagsToCheck = rawStartup.jvmFlags !== undefined ? rawStartup.jvmFlags : req.body.jvmFlags;
    const serverArgsToCheck = rawStartup.serverArgs !== undefined ? rawStartup.serverArgs : req.body.serverArgs;
    if (jvmFlagsToCheck !== undefined || serverArgsToCheck !== undefined) {
      const startupArguments = require('./startupArguments');
      startupArguments.assertSafeStartupArguments(
        jvmFlagsToCheck !== undefined ? jvmFlagsToCheck : '',
        serverArgsToCheck !== undefined ? serverArgsToCheck : '',
        { isAdmin }
      );
    }

    const updatedSettings = serverRegistry.updateSettings(req.params.id, req.body, { isAdmin });
    const requiresRestart = processManager.isRunning(req.params.id);

    res.json({
      ...updatedSettings,
      settings: updatedSettings,
      requiresRestart
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deleteFiles = req.query.deleteFiles === 'true';

    const server = serverRegistry.getById(id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }

    processManager.acquireServerLock(id, 'delete', 'Sunucu silme');
    try {
      // Stop process if running
      await processManager.stopServer(id, 3000);

      // Clean up backup records and archive files to prevent orphaned entries
      try {
        if (typeof backupManager.deleteAllForServer === 'function') {
          backupManager.deleteAllForServer(id);
        } else {
          const serverBackups = backupManager.listBackups(id);
          for (const b of serverBackups) {
            try {
              backupManager.deleteBackup(b.id, id);
            } catch (bErr) {
              console.warn(`[serversController] Sunucu yedeği silinirken hata: ${b.id}`, bErr.message);
            }
          }
          const serverBackupsDir = path.join(config.BACKUPS_DIR, id);
          if (fs.existsSync(serverBackupsDir)) {
            try {
              fs.rmSync(serverBackupsDir, { recursive: true, force: true });
            } catch (dirErr) {
              console.warn(`[serversController] Sunucu yedek dizini temizlenemedi: ${serverBackupsDir}`, dirErr.message);
            }
          }
        }
      } catch (backupCleanupErr) {
        console.warn(`[serversController] Yedekler temizlenirken hata oluştu: ${backupCleanupErr.message}`);
      }

      if (deleteFiles && server.directory && fs.existsSync(server.directory)) {
        try {
          const safeDeleteDir = serverRegistry.assertSafeServerDirectory(server.directory, id);
          fs.rmSync(safeDeleteDir, { recursive: true, force: true });
        } catch (e) {
          console.error('Sunucu dosyaları silinirken hata oluştu:', e.message);
        }
      }

      serverRegistry.delete(id);
      res.json({ success: true, message: 'Sunucu başarıyla silindi.' });
    } finally {
      processManager.releaseServerLock(id, 'delete');
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// --- ZIP Import ---
router.post('/import-zip', attachUploadCleanup, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ZIP dosyası yüklenmedi.' });
    }

    const customName = req.body.name || req.file.originalname.replace(/\.[^/.]+$/, '');
    const currentUsername = (req.user && req.user.username) ? req.user.username.trim().toLowerCase() : 'mazidev';
    const result = await zipImporter.importZip(req.file.path, customName, currentUsername);

    res.status(201).json(result);
  } catch (err) {
    cleanupMulterFiles(req);
    res.status(500).json({ error: err.message });
  }
});

// --- Process Management ---
router.post('/:id/start', async (req, res) => {
  try {
    const result = await processManager.startServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const result = await processManager.stopServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/kill', (req, res) => {
  try {
    const result = processManager.killServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/restart', async (req, res) => {
  try {
    const result = await processManager.restartServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/command', (req, res) => {
  try {
    const userKey = (req.user && req.user.username) ? req.user.username : (req.ip || 'ip');
    const rateKey = `${userKey}:${req.params.id}`;
    if (commandRateLimiter.isLimited(rateKey)) {
      return res.status(429).json({ error: 'Çok fazla konsol komutu gönderildi. Lütfen biraz bekleyin.' });
    }

    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'Komut dizisi zorunludur.' });
    }
    const result = processManager.sendCommand(req.params.id, command);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '500', 10);
    const logs = processManager.getLogs(req.params.id, limit);
    const sessionId = processManager.getSessionId(req.params.id) || '';
    res.setHeader('X-Session-Id', sessionId);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/files', (req, res) => {
  try {
    const reqPath = req.query.path || '';
    const files = fileManager.listFiles(req.params.id, reqPath);
    const entries = Array.isArray(files) ? files : (files.entries || []);
    if (req.query.format === 'array') {
      return res.json(entries);
    }
    return res.json({
      currentPath: files.currentPath || reqPath,
      entries
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const MAX_LOG_READ_BYTES = 5 * 1024 * 1024; // 5 MB

function readLogFileTail(filePath, maxBytes = MAX_LOG_READ_BYTES) {
  const isGzip = filePath.endsWith('.gz');
  if (isGzip) {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes * 2) {
      throw new Error('Sıkıştırılmış log dosyası okuma sınırını (10 MB) aşıyor.');
    }
    const compressed = fs.readFileSync(filePath);
    let decompressed;
    try {
      decompressed = zlib.gunzipSync(compressed, { maxOutputLength: maxBytes * 2 });
    } catch (gzErr) {
      throw new Error(`Arşiv açılamadı: ${gzErr.message}`);
    }
    let truncated = false;
    if (decompressed.length > maxBytes) {
      decompressed = decompressed.subarray(decompressed.length - maxBytes);
      truncated = true;
    }
    return {
      content: decompressed.toString('utf8'),
      truncated
    };
  }

  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  if (totalSize <= maxBytes) {
    return {
      content: fs.readFileSync(filePath, 'utf8'),
      truncated: false
    };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const startOffset = totalSize - maxBytes;
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, startOffset);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: true
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {}
  }
}

router.get('/:id/logs/latest', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }
    const logFilePath = path.join(server.directory, 'logs', 'latest.log');
    if (fs.existsSync(logFilePath)) {
      if (server.directory && fs.existsSync(server.directory)) {
        const realServerDir = fs.realpathSync(server.directory);
        const realLogPath = fs.realpathSync(logFilePath);
        const rel = path.relative(realServerDir, realLogPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return res.status(403).json({ error: 'Güvenlik ihlali: Sembolik bağ sunucu dizini dışına işaret ediyor.' });
        }
      }
      const { content, truncated } = readLogFileTail(logFilePath, MAX_LOG_READ_BYTES);
      return res.json({ content, filename: 'latest.log', exists: true, truncated });
    }
    const ringLogs = processManager.getLogs(req.params.id, 2000);
    const textLines = ringLogs.map((item) => (typeof item === 'string' ? item : (item.text || ''))).join('\n');
    return res.json({ content: textLines, filename: 'latest.log', exists: false, truncated: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/logs/files', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }
    const logsDir = path.join(server.directory, 'logs');
    if (!fs.existsSync(logsDir)) {
      return res.json([]);
    }

    let realServerDir = null;
    if (server.directory && fs.existsSync(server.directory)) {
      realServerDir = fs.realpathSync(server.directory);
      const realLogsDir = fs.realpathSync(logsDir);
      const relLogs = path.relative(realServerDir, realLogsDir);
      if (relLogs.startsWith('..') || path.isAbsolute(relLogs)) {
        return res.status(403).json({ error: 'Güvenlik ihlali: Log dizini sunucu dizini dışına işaret ediyor.' });
      }
    }

    const entries = fs.readdirSync(logsDir, { withFileTypes: true });
    const logFiles = [];

    for (const entry of entries) {
      if (entry.isFile() && /^[\w.-]+\.log(\.gz)?$/.test(entry.name)) {
        try {
          const filePath = path.join(logsDir, entry.name);
          if (realServerDir) {
            const realFilePath = fs.realpathSync(filePath);
            const relEntry = path.relative(realServerDir, realFilePath);
            if (relEntry.startsWith('..') || path.isAbsolute(relEntry)) {
              continue;
            }
          }
          const stat = fs.statSync(filePath);
          logFiles.push({
            name: entry.name,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            compressed: entry.name.endsWith('.gz')
          });
        } catch (e) {}
      }
    }

    // Sort: latest.log always first, others by modifiedAt descending
    logFiles.sort((a, b) => {
      if (a.name === 'latest.log') return -1;
      if (b.name === 'latest.log') return 1;
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    res.json(logFiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/logs/files/:name', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }

    const fileName = req.params.name;
    if (!fileName || !/^[\w.-]+\.log(\.gz)?$/.test(fileName)) {
      return res.status(400).json({ error: 'Geçersiz log dosya adı.' });
    }

    const logsDir = path.resolve(path.join(server.directory, 'logs'));
    const filePath = path.resolve(path.join(logsDir, fileName));

    // Path traversal prevention
    const rel = path.relative(logsDir, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).json({ error: 'Güvenlik ihlali: Dizin dışına çıkılamaz.' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Log dosyası bulunamadı.' });
    }

    // Realpath containment check
    if (server.directory && fs.existsSync(server.directory)) {
      const realServerDir = fs.realpathSync(server.directory);
      const realFilePath = fs.realpathSync(filePath);
      const relReal = path.relative(realServerDir, realFilePath);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        return res.status(403).json({ error: 'Güvenlik ihlali: Sembolik bağ sunucu dizini dışına işaret ediyor.' });
      }
    }

    const { content, truncated } = readLogFileTail(filePath, MAX_LOG_READ_BYTES);
    res.json({
      name: fileName,
      content,
      truncated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/files/content', (req, res) => {
  try {
    const reqPath = req.query.path;
    if (!reqPath) {
      return res.status(400).json({ error: 'Dosya yolu parametresi zorunludur.' });
    }
    const content = fileManager.readFileContent(req.params.id, reqPath);
    res.json(content);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const fileContentJsonParser = express.json({ limit: '50mb' });
const fileContentUrlencodedParser = express.urlencoded({ extended: true, limit: '50mb' });

router.post('/:id/files/content', fileContentJsonParser, fileContentUrlencodedParser, (req, res) => {
  try {
    const { path: reqPath, content } = req.body || {};
    if (!reqPath) {
      return res.status(400).json({ error: 'Dosya yolu zorunludur.' });
    }
    const result = fileManager.writeFileContent(req.params.id, reqPath, content !== undefined ? content : '');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/files', (req, res) => {
  try {
    const reqPath = req.query.path || req.body?.path;
    if (!reqPath) {
      return res.status(400).json({ error: 'Dosya yolu zorunludur.' });
    }
    const result = fileManager.deleteEntry(req.params.id, reqPath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/files/create-folder', (req, res) => {
  try {
    const { path: parentPath, name } = req.body;
    const result = fileManager.createFolder(req.params.id, parentPath, name);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/files/create-file', (req, res) => {
  try {
    const { path: parentPath, name, content } = req.body;
    const result = fileManager.createFile(req.params.id, parentPath, name, content || '');
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/files/rename', (req, res) => {
  try {
    const { oldPath, newName } = req.body;
    const result = fileManager.renameEntry(req.params.id, oldPath, newName);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/files/download', (req, res) => {
  try {
    const reqPath = req.query.path || '';
    const safeInfo = fileManager._resolveSafePath(req.params.id, reqPath);
    if (!fs.existsSync(safeInfo.resolvedPath)) {
      return res.status(404).json({ error: 'Dosya veya dizin bulunamadı.' });
    }

    const stat = fs.statSync(safeInfo.resolvedPath);
    if (stat.isDirectory()) {
      return fileManager.pipeDirectoryDownload(req.params.id, reqPath, res);
    }

    const item = fileManager.getDownloadItem(req.params.id, reqPath);
    res.setHeader('Content-Disposition', formatContentDisposition(item.filename));
    if (item.type === 'buffer') {
      res.setHeader('Content-Type', item.contentType);
      return res.send(item.data);
    } else {
      return res.download(item.filePath, item.filename);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err.message });
    }
  }
});

router.post('/:id/files/upload', attachUploadCleanup, upload.any(), (req, res) => {
  try {
    const targetDirRel = req.body.targetDir || '';
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }

    const { resolvedPath } = fileManager._resolveSafePath(req.params.id, targetDirRel);

    const savedFiles = [];
    if (req.files && req.files.length > 0) {
      for (const f of req.files) {
        if (!f.originalname || typeof f.originalname !== 'string') {
          throw new Error('Geçersiz dosya adı.');
        }
        if (f.originalname.includes('\0') || f.originalname.includes('/') || f.originalname.includes('\\')) {
          throw new Error('Geçersiz dosya adı: Dosya adı yol ayırıcı (/, \\) ya da boş karakter (NUL) içeremez.');
        }
        const rawName = f.originalname.trim();
        if (rawName === '.' || rawName === '..' || !rawName) {
          throw new Error('Geçersiz dosya adı: Dosya adı "." veya ".." olamaz.');
        }
        const safeName = path.basename(rawName);
        if (safeName === '.' || safeName === '..' || !safeName) {
          throw new Error('Geçersiz dosya adı: Dosya adı "." veya ".." olamaz.');
        }
        const dest = path.join(resolvedPath, safeName);
        try {
          fs.renameSync(f.path, dest);
        } catch (renameErr) {
          if (renameErr.code === 'EXDEV') {
            fs.copyFileSync(f.path, dest);
            try { fs.unlinkSync(f.path); } catch (e) {}
          } else {
            throw renameErr;
          }
        }
        savedFiles.push(safeName);
      }
    }

    res.json({
      success: true,
      message: `${savedFiles.length} dosya başarıyla yüklendi.`,
      files: savedFiles
    });
  } catch (err) {
    cleanupMulterFiles(req);
    res.status(400).json({ error: err.message });
  }
});

// --- Server Properties Endpoints ---
router.get('/:id/properties', (req, res) => {
  try {
    const props = fileManager.getServerProperties(req.params.id);
    res.json(props);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/properties', (req, res) => {
  try {
    const updated = fileManager.saveServerProperties(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/properties', (req, res) => {
  try {
    const updated = fileManager.saveServerProperties(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Server Icon Endpoints ---
router.get('/:id/icon', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }

    res.setHeader('Cache-Control', 'no-cache');

    if (server.directory && fs.existsSync(server.directory)) {
      try {
        const realServerDir = fs.realpathSync(server.directory);
        const possibleIcons = [
          path.join(server.directory, 'server-icon.png'),
          path.join(server.directory, 'icon.png')
        ];

        for (const p of possibleIcons) {
          if (fs.existsSync(p)) {
            try {
              const realIconPath = fs.realpathSync(p);
              const rel = path.relative(realServerDir, realIconPath);
              if (rel.startsWith('..') || path.isAbsolute(rel)) {
                // Symlink escapes root - reject it!
                continue;
              }
              res.setHeader('Content-Type', 'image/png');
              return res.sendFile(realIconPath);
            } catch (e) {
              continue;
            }
          }
        }
      } catch (e) {}
    }

    // Fallback to default panel logo
    const fallbackLogos = [
      path.join(config.BASE_DIR, 'logo.jpg'),
      path.join(config.BASE_DIR, 'client/dist/logo.jpg'),
      path.join(config.BASE_DIR, 'client/public/logo.jpg'),
      path.resolve(__dirname, '../../../../logo.jpg')
    ];

    for (const fl of fallbackLogos) {
      if (fs.existsSync(fl)) {
        res.setHeader('Content-Type', fl.endsWith('.png') ? 'image/png' : 'image/jpeg');
        return res.sendFile(path.resolve(fl));
      }
    }

    // 1x1 transparent PNG fallback buffer
    const fallbackPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    res.setHeader('Content-Type', 'image/png');
    return res.send(fallbackPng);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/icon', attachUploadCleanup, upload.any(), (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }

    const uploadedFile = (req.files && req.files.length > 0)
      ? (req.files.find((f) => f.fieldname === 'icon') || req.files[0])
      : req.file;

    if (!uploadedFile) {
      return res.status(400).json({ error: 'Görsel dosyası yüklenmedi.' });
    }

    // Verify PNG signature (first 8 bytes) and 64x64 dimensions from IHDR (bytes 16-23, big-endian)
    let isValid64x64Png = false;
    try {
      const buffer = fs.readFileSync(uploadedFile.path);
      if (buffer.length >= 24) {
        const isPng =
          buffer[0] === 0x89 &&
          buffer[1] === 0x50 &&
          buffer[2] === 0x4e &&
          buffer[3] === 0x47 &&
          buffer[4] === 0x0d &&
          buffer[5] === 0x0a &&
          buffer[6] === 0x1a &&
          buffer[7] === 0x0a;

        if (isPng) {
          const width = buffer.readUInt32BE(16);
          const height = buffer.readUInt32BE(20);
          if (width === 64 && height === 64) {
            isValid64x64Png = true;
          }
        }
      }
    } catch (e) {
      isValid64x64Png = false;
    }

    if (!isValid64x64Png) {
      cleanupMulterFiles(req);
      return res.status(400).json({
        error: 'Geçersiz görsel formatı. Sunucu ikonu yalnızca 64x64 piksel PNG formatında olmalıdır.'
      });
    }

    const targetIconPath = path.join(server.directory, 'server-icon.png');
    const aliasIconPath = path.join(server.directory, 'icon.png');

    try {
      fs.copyFileSync(uploadedFile.path, targetIconPath);
      fs.copyFileSync(uploadedFile.path, aliasIconPath);
      cleanupMulterFiles(req);
    } catch (fsErr) {
      cleanupMulterFiles(req);
      return res.status(500).json({ error: `Görsel kaydedilemedi: ${fsErr.message}` });
    }

    const iconVersion = Date.now();
    const cacheBustingUrl = `/api/servers/${server.id}/icon?v=${iconVersion}`;

    serverRegistry.update(server.id, {
      iconVersion,
      iconUrl: cacheBustingUrl,
      icon: cacheBustingUrl
    });

    res.json({
      success: true,
      message: 'Sunucu ikonu başarıyla güncellendi.',
      icon: cacheBustingUrl,
      iconUrl: cacheBustingUrl,
      iconVersion
    });
  } catch (err) {
    cleanupMulterFiles(req);
    res.status(500).json({ error: err.message });
  }
});

// --- Player Management Endpoints ---
router.get('/:id/players', async (req, res) => {
  try {
    const online = await playerManager.getOnlinePlayersAsync(req.params.id);
    res.json({ online, count: online.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/players/lists', (req, res) => {
  try {
    const lists = playerManager.getPlayerLists(req.params.id);
    res.json(lists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/players/kick', (req, res) => {
  try {
    const { player, reason } = req.body;
    const result = playerManager.kickPlayer(req.params.id, player, reason);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/players/ban', (req, res) => {
  try {
    const { player, reason } = req.body;
    const result = playerManager.banPlayer(req.params.id, player, reason);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/players/unban', (req, res) => {
  try {
    const { player } = req.body;
    const result = playerManager.unbanPlayer(req.params.id, player);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/players/op', (req, res) => {
  try {
    const { player } = req.body;
    const result = playerManager.opPlayer(req.params.id, player);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/players/deop', (req, res) => {
  try {
    const { player } = req.body;
    const result = playerManager.deopPlayer(req.params.id, player);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/players/whitelist/add', (req, res) => {
  try {
    const { player } = req.body;
    const result = playerManager.whitelistAdd(req.params.id, player);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/players/whitelist/remove', (req, res) => {
  try {
    const { player } = req.body;
    const result = playerManager.whitelistRemove(req.params.id, player);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Backup Management per Server ---
router.get('/:id/backups', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }
    const backups = backupManager.listBackups(req.params.id);
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/backups', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.exclusions !== undefined) {
      body.exclusions = backupManager.sanitizeExclusions(body.exclusions);
    }
    const backup = await backupManager.createBackup(req.params.id, body);
    res.status(201).json(backup);
  } catch (err) {
    console.error('[Yedek Oluşturma Hatası]:', err);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/:id/backups/:backupId/restore', async (req, res) => {
  try {
    const forceStop = req.body.forceStop === true || req.query.forceStop === 'true';
    const result = await backupManager.restoreBackup(req.params.id, req.params.backupId, { forceStop });
    res.json(result);
  } catch (err) {
    console.error('[Yedek Geri Yükleme Hatası]:', err);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.delete('/:id/backups/:backupId', (req, res) => {
  try {
    const result = backupManager.deleteBackup(req.params.backupId, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get('/:id/backups/:backupId/download', (req, res) => {
  try {
    const backup = backupManager.getBackupById(req.params.backupId);
    if (!backup || backup.serverId !== req.params.id) {
      return res.status(404).json({ error: 'Bu sunucuya ait yedek bulunamadı.' });
    }
    if (!fs.existsSync(backup.filePath)) {
      return res.status(404).json({ error: 'Yedek dosyası diskte bulunamadı.' });
    }
    res.setHeader('Content-Disposition', formatContentDisposition(backup.filename));
    res.download(backup.filePath, backup.filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global multer error handling for file upload routes
router.use((err, req, res, next) => {
  cleanupMulterFiles(req);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Dosya yükleme hatası: ${err.message}` });
  }
  next(err);
});

router.readActualMaxPlayers = readActualMaxPlayers;
router.resolveJavaExecutable = resolveJavaExecutable;
router.canAccessServer = canAccessServer;

module.exports = router;
