const fs = require('fs');
const path = require('path');
const config = require('../../config');
const defaultIconHelper = require('./defaultIconHelper');
const javaDetector = require('../system/javaDetector');

const SERVERS_FILE = path.join(config.DATA_DIR, 'servers.json');

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
    throw err;
  }
}

function validateServerId(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('Geçersiz sunucu kimliği (ID).');
  }
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    throw new Error('Geçersiz sunucu kimliği (ID). Yalnızca harf, rakam, tire ve alt çizgi kullanılabilir.');
  }
  return trimmed;
}

function validateJarFile(jarFile) {
  if (!jarFile || typeof jarFile !== 'string') {
    throw new Error('Geçerli bir jarFile dosya adı belirtilmelidir.');
  }
  const trimmed = jarFile.trim();
  if (
    !trimmed ||
    trimmed.length > 128 ||
    /[\r\n\x00-\x1f\x7f]/.test(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    path.basename(trimmed) !== trimmed ||
    !/^[a-zA-Z0-9._+-]+\.jar$/i.test(trimmed)
  ) {
    throw new Error('Geçersiz jarFile dosya adı. Yalnızca sunucu dizinindeki geçerli bir .jar dosya adı belirtilebilir.');
  }
  return trimmed;
}

function validateJavaPath(javaPath, options = {}) {
  if (javaPath === undefined || javaPath === null) return '';
  if (typeof javaPath !== 'string') {
    throw new Error('Geçersiz Java yolu formatı.');
  }
  const trimmed = javaPath.trim();
  if (!trimmed || trimmed === 'auto') return trimmed;
  if (/[\r\n\x00-\x1f\x7f]/.test(trimmed) || trimmed.length > 260) {
    throw new Error('Geçersiz Java yürütülebilir dosya yolu.');
  }
  if (
    trimmed === 'java' ||
    trimmed === 'java.exe' ||
    /^\d+$/.test(trimmed) ||
    /^java-\d+$/i.test(trimmed)
  ) {
    return trimmed;
  }
  if (!javaDetector.isSafeJavaExecutablePath(trimmed)) {
    throw new Error('Geçersiz veya güvenli olmayan Java yürütülebilir dosya yolu.');
  }
  if (options && options.isAdmin === false) {
    const installed = javaDetector.detectJavaInstallations() || [];
    const resolvedTarget = path.resolve(trimmed);
    const isKnown = installed.some((item) => item && item.path && path.resolve(item.path) === resolvedTarget);
    if (!isKnown) {
      throw new Error('Özel Java dosya yolu belirleme yetkiniz yok. Lütfen listedeki kurulu bir Java sürümünü seçin.');
    }
  }
  return trimmed;
}

function assertSafeServerDirectory(targetDir, currentServerId = null, existingServers = []) {
  if (!targetDir || typeof targetDir !== 'string' || /[\r\n\x00-\x1f\x7f]/.test(targetDir)) {
    throw new Error('Geçersiz sunucu dizini yolu.');
  }
  const resolvedDir = path.resolve(targetDir);
  const resolvedServersDir = config.SERVERS_DIR ? path.resolve(config.SERVERS_DIR) : null;
  const resolvedTempDir = config.TEMP_DIR ? path.resolve(config.TEMP_DIR) : null;
  const resolvedDebianTemp = path.resolve('/mazideveloper/temp');
  const resolvedTestsDir = path.resolve(__dirname, '../../tests');

  const isInsideServers = Boolean(resolvedServersDir) && (() => {
    const rel = path.relative(resolvedServersDir, resolvedDir);
    return Boolean(rel) && rel !== '.' && !rel.startsWith('..') && !path.isAbsolute(rel);
  })();

  const isInsideTemp = [resolvedTempDir, resolvedDebianTemp].filter(Boolean).some((tempRoot) => {
    const rel = path.relative(tempRoot, resolvedDir);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });

  const isInsideTestTemp = (() => {
    const rel = path.relative(resolvedTestsDir, resolvedDir);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(resolvedDir).startsWith('temp_');
  })();

  const allowedRoots = [resolvedServersDir, resolvedTempDir, resolvedDebianTemp, resolvedTestsDir].filter(Boolean);
  const isInsideAllowed = isInsideServers || isInsideTemp || isInsideTestTemp;

  if (!isInsideAllowed) {
    throw new Error(`Sunucu dizini güvenli sunucu klasörü (${config.SERVERS_DIR}) içinde yer almalıdır.`);
  }

  const forbiddenRoots = [
    config.DATA_DIR ? path.resolve(config.DATA_DIR) : null,
    config.BACKUPS_DIR ? path.resolve(config.BACKUPS_DIR) : null,
    config.CLIENT_DIST_DIR ? path.resolve(config.CLIENT_DIST_DIR) : null,
    path.resolve(__dirname, '..')
  ].filter(Boolean);

  for (const forbidden of forbiddenRoots) {
    const rel = path.relative(forbidden, resolvedDir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new Error('Sunucu dizini sistem veya veri klasörleri içinde olamaz.');
    }
  }

  if (fs.existsSync(resolvedDir)) {
    let realDir;
    try {
      realDir = fs.realpathSync(resolvedDir);
    } catch (e) {
      throw new Error('Sunucu dizini doğrulanamadı.');
    }
    const realInsideAllowed = allowedRoots.some((root) => {
      const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
      const rel = path.relative(realRoot, realDir);
      if (resolvedServersDir && root === resolvedServersDir) {
        return Boolean(rel) && rel !== '.' && !rel.startsWith('..') && !path.isAbsolute(rel);
      }
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!realInsideAllowed) {
      throw new Error('Sunucu dizini sembolik bağlantı ile izin verilen alanın dışına çıkamaz.');
    }
  }

  if (Array.isArray(existingServers) && !isInsideTestTemp) {
    const dirConflict = existingServers.some(
      (s) => s && s.id !== currentServerId && s.directory && path.resolve(s.directory) === resolvedDir
    );
    if (dirConflict) {
      throw new Error('Bu sunucu dizini zaten başka bir sunucu tarafından kullanılıyor.');
    }
  }

  return resolvedDir;
}

function parseRamToMB(ramStr, fallbackMB = 2048) {
  if (ramStr === undefined || ramStr === null || ramStr === '') return fallbackMB;
  const match = String(ramStr).trim().match(/^(\d+)\s*([gmkGMK]?)(?:b|ib)?$/i);
  if (!match) return fallbackMB;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || 'g').toLowerCase();
  if (unit === 'g') return val * 1024;
  if (unit === 'm') return val;
  if (unit === 'k') return Math.round(val / 1024);
  return val * 1024;
}

function formatRam(ram, fallback = '2G') {
  if (ram === undefined || ram === null || ram === '') return fallback;
  let str = String(ram).trim().replace(/\s+/g, '');
  str = str.replace(/([gmk])b$/i, '$1');
  if (/^\d+$/.test(str)) return `${str}G`;
  if (/^\d+[gmkGMK]$/.test(str)) return str.toUpperCase();
  return fallback;
}

function formatRamDisplay(ram, fallback = '2GB') {
  if (ram === undefined || ram === null || ram === '') return fallback;
  const str = String(ram).trim().toUpperCase();
  if (str.endsWith('GB') || str.endsWith('MB')) return str;
  if (str.endsWith('G')) return str + 'B';
  if (str.endsWith('M')) return str + 'B';
  if (/^\d+$/.test(str)) return str + 'GB';
  return str;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

function deepMerge(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  return output;
}

function getDefaultSettings(server = {}) {
  const minMB = parseRamToMB(server.minRam, 2048);
  const maxMB = parseRamToMB(server.maxRam, 4096);
  return {
    memory: {
      minMB,
      maxMB
    },
    startup: {
      jarFile: server.jarFile || 'server.jar',
      javaPath: (server.javaPath && String(server.javaPath).trim()) ? String(server.javaPath).trim() : null,
      jvmFlags: server.jvmFlags || '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
      serverArgs: server.serverArgs || 'nogui'
    },
    autoStartOnBoot: server.autoStartOnBoot || 'last_state',
    crash: {
      autoRestart: server.autoRestart !== false,
      maxRetries: typeof server.maxCrashRetries === 'number' ? server.maxCrashRetries : 5,
      delaySec: 3
    },
    stop: {
      command: 'stop',
      timeoutSec: 30,
      onTimeout: 'kill'
    },
    restart: {
      mode: 'graceful',
      delaySec: 1,
      warnMessage: null,
      warnSeconds: 5
    }
  };
}

class ServerRegistry {
  constructor() {
    this._load();
  }

  _load() {
    if (!fs.existsSync(SERVERS_FILE)) {
      this.servers = [];
      this._save();
      return;
    }
    try {
      const data = fs.readFileSync(SERVERS_FILE, 'utf8');
      this.servers = JSON.parse(data);
    } catch (err) {
      console.error('servers.json okunamadı, boş liste ile başlatılıyor:', err.message);
      this.servers = [];
    }

    // Ensure all servers have an owner. If missing, assign to default admin account
    let migrated = false;
    let defaultOwner = 'mazidev';
    try {
      const authService = require('../auth/authService');
      defaultOwner = authService.getFirstAdminUsername() || 'mazidev';
    } catch (e) {
      defaultOwner = 'mazidev';
    }
    defaultOwner = defaultOwner.toLowerCase();

    for (const server of this.servers) {
      if (!server.owner || typeof server.owner !== 'string' || !server.owner.trim()) {
        server.owner = defaultOwner;
        migrated = true;
      } else {
        server.owner = server.owner.trim().toLowerCase();
      }
    }

    if (migrated && this.servers.length > 0) {
      this._save();
    }
  }

  _save() {
    try {
      atomicWriteFileSync(SERVERS_FILE, JSON.stringify(this.servers, null, 2));
    } catch (err) {
      console.error('servers.json kaydedilemedi:', err.message);
    }
  }

  getAll(requestUsername = null) {
    this._load();
    if (requestUsername && typeof requestUsername === 'string' && requestUsername.trim()) {
      const norm = requestUsername.trim().toLowerCase();
      return this.servers.filter((s) => (s.owner || '').toLowerCase() === norm);
    }
    return this.servers;
  }

  getById(id, requestUsername = null) {
    this._load();
    const server = this.servers.find((s) => s.id === id) || null;
    if (!server) return null;
    if (requestUsername && typeof requestUsername === 'string' && requestUsername.trim()) {
      const norm = requestUsername.trim().toLowerCase();
      if ((server.owner || '').toLowerCase() !== norm) {
        return null;
      }
    }
    return server;
  }

  updateServerOwner(oldUsername, newUsername) {
    this._load();
    if (!oldUsername || !newUsername) return;
    const oldNorm = oldUsername.trim().toLowerCase();
    const newNorm = newUsername.trim().toLowerCase();
    let updated = false;
    for (const server of this.servers) {
      if ((server.owner || '').toLowerCase() === oldNorm) {
        server.owner = newNorm;
        server.updatedAt = new Date().toISOString();
        updated = true;
      }
    }
    if (updated) {
      this._save();
    }
  }

  getServerSettings(server) {
    if (!server) return getDefaultSettings();
    const defaults = getDefaultSettings(server);
    if (!server.settings) {
      return defaults;
    }
    return deepMerge(defaults, server.settings);
  }

  register(serverData, options = {}) {
    this._load();

    if (serverData.name !== undefined && serverData.name !== null) {
      if (typeof serverData.name !== 'string' || !serverData.name.trim()) {
        throw new Error('Sunucu adı metin formatında olmalı ve boş bırakılmamalıdır.');
      }
      if (/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/.test(serverData.name)) {
        throw new Error('Sunucu adı satır sonu veya geçersiz kontrol karakterleri içeremez.');
      }
      serverData.name = serverData.name.trim();
    }

    if (!serverData.id) {
      serverData.id = 'srv-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 4);
    } else {
      serverData.id = validateServerId(serverData.id);
    }

    // Determine and validate directory
    let targetDirectory = serverData.directory;
    if (!targetDirectory) {
      targetDirectory = path.join(config.SERVERS_DIR, serverData.id);
    }
    const resolvedDir = assertSafeServerDirectory(targetDirectory, serverData.id, this.servers);

    const existingIndex = this.servers.findIndex((s) => s.id === serverData.id);
    const now = new Date().toISOString();

    const existing = existingIndex >= 0 ? this.servers[existingIndex] : {};
    const minRamFormatted = formatRam(serverData.minRam, '2G');
    const maxRamFormatted = formatRam(serverData.maxRam, '4G');

    let owner = (serverData.owner && String(serverData.owner).trim().toLowerCase())
      || (existing.owner && String(existing.owner).trim().toLowerCase());
    if (!owner) {
      try {
        const authService = require('../auth/authService');
        owner = authService.getFirstAdminUsername() || 'mazidev';
      } catch (e) {
        owner = 'mazidev';
      }
    }
    if (!owner) owner = 'mazidev';
    owner = owner.toLowerCase();

    const tempServer = {
      ...existing,
      ...serverData,
      owner,
      minRam: minRamFormatted,
      maxRam: maxRamFormatted
    };

    const settings = serverData.settings
      ? deepMerge(getDefaultSettings(tempServer), serverData.settings)
      : this.getServerSettings(tempServer);

    const validatedJarFile = validateJarFile(settings.startup.jarFile || serverData.jarFile || 'server.jar');
    const rawJavaPath = settings.startup.javaPath !== undefined && settings.startup.javaPath !== null
      ? settings.startup.javaPath
      : (serverData.javaPath || '');
    const validatedJavaPath = validateJavaPath(rawJavaPath, options);
    settings.startup.jarFile = validatedJarFile;
    settings.startup.javaPath = validatedJavaPath || null;

    const parsedMaxPlayers = serverData.maxPlayers !== undefined && serverData.maxPlayers !== null && !isNaN(parseInt(serverData.maxPlayers, 10))
      ? parseInt(serverData.maxPlayers, 10)
      : (existing.maxPlayers || 10);

    let finalPort;
    if (serverData.port !== undefined && serverData.port !== null && serverData.port !== '') {
      finalPort = parseInt(serverData.port, 10);
      if (isNaN(finalPort) || finalPort < 1024 || finalPort > 65535) {
        throw new Error('Port 1024 ile 65535 arasında geçerli bir tam sayı olmalıdır.');
      }
      const portConflict = this.servers.some((s) => s.id !== serverData.id && parseInt(s.port, 10) === finalPort);
      if (portConflict) {
        throw new Error('Bu port zaten başka bir sunucu tarafından kullanılıyor.');
      }
    } else if (existing.port) {
      finalPort = parseInt(existing.port, 10) || 25565;
    } else {
      finalPort = 25565;
      const usedPorts = new Set(
        this.servers
          .filter((s) => s.id !== serverData.id)
          .map((s) => parseInt(s.port, 10))
          .filter((p) => !isNaN(p))
      );
      while (usedPorts.has(finalPort) && finalPort < 65535) {
        finalPort += 1;
      }
    }

    const record = {
      id: serverData.id,
      name: serverData.name || serverData.id,
      owner,
      directory: resolvedDir,
      jarFile: validatedJarFile,
      javaPath: validatedJavaPath,
      minRam: minRamFormatted,
      maxRam: maxRamFormatted,
      jvmFlags: settings.startup.jvmFlags || serverData.jvmFlags || '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
      serverArgs: settings.startup.serverArgs || serverData.serverArgs || 'nogui',
      port: finalPort,
      maxPlayers: parsedMaxPlayers,
      autoRestart: settings.crash.autoRestart,
      maxCrashRetries: settings.crash.maxRetries,
      autoStartOnBoot: settings.autoStartOnBoot,
      lastRunning: serverData.lastRunning !== undefined ? Boolean(serverData.lastRunning) : Boolean(existing.lastRunning),
      settings,
      type: serverData.type || existing.type || 'purpur',
      version: serverData.version || existing.version || '1.20.4',
      icon: serverData.icon !== undefined ? serverData.icon : (existing.icon || null),
      iconUrl: serverData.iconUrl !== undefined ? serverData.iconUrl : (existing.iconUrl || null),
      iconVersion: serverData.iconVersion !== undefined ? serverData.iconVersion : (existing.iconVersion || null),
      createdAt: serverData.createdAt || existing.createdAt || now,
      updatedAt: now
    };

    const startupArguments = require('./startupArguments');
    startupArguments.assertSafeStartupArguments(
      record.jvmFlags,
      record.serverArgs,
      { isAdmin: Boolean(options && options.isAdmin) }
    );

    // Ensure 64x64 default server-icon.png exists in server directory
    if (resolvedDir) {
      try {
        defaultIconHelper.ensureServerIcon(resolvedDir);
      } catch (err) {
        console.warn(`[serverRegistry] Varsayılan sunucu ikonu oluşturulamadı: ${err.message}`);
      }
    }

    if (existingIndex >= 0) {
      this.servers[existingIndex] = { ...this.servers[existingIndex], ...record, updatedAt: now };
    } else {
      this.servers.push(record);
    }

    this._save();
    return record;
  }

  update(id, updates, options = {}) {
    this._load();
    const index = this.servers.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new Error(`"${id}" kimliğine sahip sunucu bulunamadı.`);
    }

    const sanitizedUpdates = { ...updates };
    // Protect immutable fields from update injection
    delete sanitizedUpdates.id;
    delete sanitizedUpdates.directory;
    delete sanitizedUpdates.createdAt;
    if (!(options && options.isAdmin && typeof sanitizedUpdates.owner === 'string' && sanitizedUpdates.owner.trim())) {
      delete sanitizedUpdates.owner;
    } else {
      sanitizedUpdates.owner = sanitizedUpdates.owner.trim().toLowerCase();
    }

    if (sanitizedUpdates.name !== undefined) {
      if (typeof sanitizedUpdates.name !== 'string' || !sanitizedUpdates.name.trim()) {
        throw new Error('Sunucu adı metin formatında olmalı ve boş bırakılmamalıdır.');
      }
      if (/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/.test(sanitizedUpdates.name)) {
        throw new Error('Sunucu adı satır sonu veya geçersiz kontrol karakterleri içeremez.');
      }
      sanitizedUpdates.name = sanitizedUpdates.name.trim();
    }
    if (sanitizedUpdates.minRam !== undefined) {
      sanitizedUpdates.minRam = formatRam(sanitizedUpdates.minRam, this.servers[index].minRam || '2G');
    }
    if (sanitizedUpdates.maxRam !== undefined) {
      sanitizedUpdates.maxRam = formatRam(sanitizedUpdates.maxRam, this.servers[index].maxRam || '4G');
    }
    if (sanitizedUpdates.port !== undefined) {
      const p = parseInt(sanitizedUpdates.port, 10);
      if (isNaN(p) || p < 1024 || p > 65535) {
        throw new Error('Port 1024 ile 65535 arasında geçerli bir tam sayı olmalıdır.');
      }
      const conflict = this.servers.some((s) => s.id !== id && parseInt(s.port, 10) === p);
      if (conflict) {
        throw new Error('Bu port zaten başka bir sunucu tarafından kullanılıyor.');
      }
      sanitizedUpdates.port = p;
    }
    if (sanitizedUpdates.maxPlayers !== undefined && sanitizedUpdates.maxPlayers !== null) {
      const mp = parseInt(sanitizedUpdates.maxPlayers, 10);
      if (!isNaN(mp) && mp > 0) {
        sanitizedUpdates.maxPlayers = mp;
      }
    }

    // Keep settings in sync if legacy fields changed
    const currentSettings = this.getServerSettings(this.servers[index]);
    if (sanitizedUpdates.minRam !== undefined) {
      currentSettings.memory.minMB = parseRamToMB(sanitizedUpdates.minRam);
    }
    if (sanitizedUpdates.maxRam !== undefined) {
      currentSettings.memory.maxMB = parseRamToMB(sanitizedUpdates.maxRam);
    }
    if (sanitizedUpdates.jarFile !== undefined) {
      sanitizedUpdates.jarFile = validateJarFile(sanitizedUpdates.jarFile);
      currentSettings.startup.jarFile = sanitizedUpdates.jarFile;
    }
    if (sanitizedUpdates.javaPath !== undefined) {
      const validatedJava = validateJavaPath(sanitizedUpdates.javaPath, options);
      sanitizedUpdates.javaPath = validatedJava;
      currentSettings.startup.javaPath = validatedJava || null;
    }
    if (sanitizedUpdates.jvmFlags !== undefined) {
      currentSettings.startup.jvmFlags = sanitizedUpdates.jvmFlags;
    }
    if (sanitizedUpdates.serverArgs !== undefined) {
      currentSettings.startup.serverArgs = sanitizedUpdates.serverArgs;
    }
    if (sanitizedUpdates.autoRestart !== undefined) {
      currentSettings.crash.autoRestart = Boolean(sanitizedUpdates.autoRestart);
    }
    if (sanitizedUpdates.maxCrashRetries !== undefined) {
      currentSettings.crash.maxRetries = parseInt(sanitizedUpdates.maxCrashRetries, 10) || 5;
    }
    if (sanitizedUpdates.autoStartOnBoot !== undefined) {
      currentSettings.autoStartOnBoot = sanitizedUpdates.autoStartOnBoot;
    }

    // Validate JVM flags if updated
    if (sanitizedUpdates.jvmFlags !== undefined || sanitizedUpdates.serverArgs !== undefined) {
      const startupArguments = require('./startupArguments');
      startupArguments.assertSafeStartupArguments(
        sanitizedUpdates.jvmFlags !== undefined ? sanitizedUpdates.jvmFlags : currentSettings.startup.jvmFlags,
        sanitizedUpdates.serverArgs !== undefined ? sanitizedUpdates.serverArgs : currentSettings.startup.serverArgs,
        { isAdmin: Boolean(options && options.isAdmin) }
      );
    }

    // If port changed, sync to server.properties atomically
    if (sanitizedUpdates.port !== undefined && sanitizedUpdates.port !== parseInt(this.servers[index].port, 10)) {
      const serverDir = this.servers[index].directory;
      if (serverDir && fs.existsSync(serverDir)) {
        const propsPath = path.join(serverDir, 'server.properties');
        if (fs.existsSync(propsPath)) {
          try {
            let propsContent = fs.readFileSync(propsPath, 'utf8');
            const updateProp = (content, key, val) => {
              const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
              return regex.test(content)
                ? content.replace(regex, `${key}=${val}`)
                : content.trimEnd() + `\n${key}=${val}\n`;
            };
            propsContent = updateProp(propsContent, 'server-port', sanitizedUpdates.port);
            propsContent = updateProp(propsContent, 'query.port', sanitizedUpdates.port);
            atomicWriteFileSync(propsPath, propsContent);
          } catch (propsErr) {
            console.warn(`[serverRegistry] server.properties port güncellenemedi: ${propsErr.message}`);
          }
        }
      }
    }

    sanitizedUpdates.settings = currentSettings;

    // Protect immutable fields
    const updated = {
      ...this.servers[index],
      ...sanitizedUpdates,
      id,
      directory: this.servers[index].directory,
      updatedAt: new Date().toISOString()
    };

    this.servers[index] = updated;
    this._save();
    return updated;
  }

  updateSettings(id, partialSettings, options = {}) {
    this._load();
    const index = this.servers.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new Error(`"${id}" kimliğine sahip sunucu bulunamadı.`);
    }

    if (!partialSettings || typeof partialSettings !== 'object' || Array.isArray(partialSettings)) {
      throw new Error('Geçersiz ayarlar verisi.');
    }

    const currentServer = this.servers[index];
    const currentSettings = this.getServerSettings(currentServer);
    const merged = deepMerge(currentSettings, partialSettings);

    // Validation
    // 1. memory
    if (merged.memory) {
      const min = Number(merged.memory.minMB);
      const max = Number(merged.memory.maxMB);
      if (isNaN(min) || min <= 0 || isNaN(max) || max <= 0) {
        throw new Error('Bellek değerleri (minMB, maxMB) pozitif sayı olmalıdır.');
      }
      if (min > max) {
        throw new Error('Minimum bellek miktarı maksimum bellekten büyük olamaz.');
      }
      merged.memory.minMB = Math.round(min);
      merged.memory.maxMB = Math.round(max);
    }

    // 2. startup
    if (merged.startup) {
      merged.startup.jarFile = validateJarFile(merged.startup.jarFile);
      if (merged.startup.javaPath !== null && merged.startup.javaPath !== undefined) {
        if (typeof merged.startup.javaPath !== 'string' || !merged.startup.javaPath.trim()) {
          merged.startup.javaPath = null;
        } else {
          const validatedJava = validateJavaPath(merged.startup.javaPath, options);
          merged.startup.javaPath = validatedJava || null;
        }
      } else {
        merged.startup.javaPath = null;
      }
      if (typeof merged.startup.jvmFlags !== 'string') {
        merged.startup.jvmFlags = '';
      }
      if (typeof merged.startup.serverArgs !== 'string') {
        merged.startup.serverArgs = 'nogui';
      }

      const startupArguments = require('./startupArguments');
      startupArguments.assertSafeStartupArguments(
        merged.startup.jvmFlags,
        merged.startup.serverArgs,
        { isAdmin: Boolean(options && options.isAdmin) }
      );
    }

    // 3. autoStartOnBoot
    if (!['never', 'always', 'last_state'].includes(merged.autoStartOnBoot)) {
      throw new Error("autoStartOnBoot değeri 'never', 'always' veya 'last_state' olmalıdır.");
    }

    // 4. crash
    if (merged.crash) {
      merged.crash.autoRestart = Boolean(merged.crash.autoRestart);
      const retries = Number(merged.crash.maxRetries);
      if (isNaN(retries) || retries < 0) {
        throw new Error('maxRetries 0 veya daha büyük bir sayı olmalıdır.');
      }
      merged.crash.maxRetries = Math.round(retries);
      const delay = Number(merged.crash.delaySec);
      if (isNaN(delay) || delay < 0) {
        throw new Error('delaySec 0 veya daha büyük bir sayı olmalıdır.');
      }
      merged.crash.delaySec = Math.round(delay);
    }

    // 5. stop
    if (merged.stop) {
      if (!merged.stop.command || typeof merged.stop.command !== 'string' || !merged.stop.command.trim()) {
        throw new Error('Durdurma komutu boş olamaz.');
      }
      merged.stop.command = merged.stop.command.trim();
      const timeout = Number(merged.stop.timeoutSec);
      if (isNaN(timeout) || timeout <= 0) {
        throw new Error('timeoutSec pozitif bir sayı olmalıdır.');
      }
      merged.stop.timeoutSec = Math.round(timeout);
      if (!['kill', 'none'].includes(merged.stop.onTimeout)) {
        throw new Error("onTimeout değeri 'kill' veya 'none' olmalıdır.");
      }
    }

    // 6. restart
    if (merged.restart) {
      if (!['graceful', 'kill'].includes(merged.restart.mode)) {
        throw new Error("restart mode 'graceful' veya 'kill' olmalıdır.");
      }
      const rDelay = Number(merged.restart.delaySec);
      if (isNaN(rDelay) || rDelay < 0) {
        throw new Error('restart delaySec 0 veya daha büyük olmalıdır.');
      }
      merged.restart.delaySec = Math.round(rDelay);
      if (merged.restart.warnMessage !== null && merged.restart.warnMessage !== undefined) {
        if (typeof merged.restart.warnMessage === 'string' && merged.restart.warnMessage.trim()) {
          merged.restart.warnMessage = merged.restart.warnMessage.trim();
        } else {
          merged.restart.warnMessage = null;
        }
      } else {
        merged.restart.warnMessage = null;
      }
      const wSec = Number(merged.restart.warnSeconds);
      if (isNaN(wSec) || wSec < 0) {
        merged.restart.warnSeconds = 0;
      } else {
        merged.restart.warnSeconds = Math.round(wSec);
      }
    }

    // Sync legacy fields
    currentServer.settings = merged;
    const minMB = merged.memory.minMB;
    const maxMB = merged.memory.maxMB;
    currentServer.minRam = (minMB >= 1024 && minMB % 1024 === 0) ? `${minMB / 1024}G` : `${minMB}M`;
    currentServer.maxRam = (maxMB >= 1024 && maxMB % 1024 === 0) ? `${maxMB / 1024}G` : `${maxMB}M`;
    currentServer.jarFile = merged.startup.jarFile;
    currentServer.javaPath = merged.startup.javaPath || '';
    currentServer.jvmFlags = merged.startup.jvmFlags;
    currentServer.serverArgs = merged.startup.serverArgs;
    currentServer.autoRestart = merged.crash.autoRestart;
    currentServer.maxCrashRetries = merged.crash.maxRetries;
    currentServer.autoStartOnBoot = merged.autoStartOnBoot;
    currentServer.updatedAt = new Date().toISOString();

    this.servers[index] = currentServer;
    this._save();
    return merged;
  }

  delete(id) {
    this._load();
    const index = this.servers.findIndex((s) => s.id === id);
    if (index === -1) {
      return false;
    }
    const removed = this.servers.splice(index, 1)[0];
    this._save();
    return removed;
  }
}

module.exports = new ServerRegistry();
module.exports.formatRamDisplay = formatRamDisplay;
module.exports.parseRamToMB = parseRamToMB;
module.exports.validateJarFile = validateJarFile;
module.exports.validateJavaPath = validateJavaPath;
module.exports.assertSafeServerDirectory = assertSafeServerDirectory;
module.exports.validateServerId = validateServerId;
module.exports.atomicWriteFileSync = atomicWriteFileSync;

