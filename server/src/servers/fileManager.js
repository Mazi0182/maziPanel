const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const serverRegistry = require('./serverRegistry');

const EDITABLE_EXTENSIONS = new Set([
  '.txt', '.yml', '.yaml', '.json', '.properties', '.log', '.sh', '.sk',
  '.conf', '.cfg', '.toml', '.env', '.md', '.xml', '.ini'
]);

function formatContentDisposition(filename) {
  const safeAscii = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

const NEWLINE_OR_NUL_REGEX = /[\r\n\u2028\u2029\u0085\0]/;
const SAFE_PROPERTY_KEY_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;

const KNOWN_PROPERTY_RANGES = {
  'server-port': { min: 1024, max: 65535, label: 'Sunucu portu (server-port)' },
  'max-players': { min: 1, max: 1000, label: 'Maksimum oyuncu sayısı (max-players)' },
  'view-distance': { min: 2, max: 32, label: 'Görüş mesafesi (view-distance)' },
  'simulation-distance': { min: 2, max: 32, label: 'Simülasyon mesafesi (simulation-distance)' },
  'spawn-protection': { min: 0, max: 10000, label: 'Doğma alanı koruması (spawn-protection)' },
  'op-permission-level': { min: 1, max: 4, label: 'Yönetici yetki seviyesi (op-permission-level)' },
  'function-permission-level': { min: 1, max: 4, label: 'Fonksiyon yetki seviyesi (function-permission-level)' }
};

const KNOWN_BOOLEAN_KEYS = new Set([
  'pvp', 'white-list', 'online-mode', 'allow-flight', 'enable-command-block',
  'spawn-animals', 'spawn-monsters', 'spawn-npcs', 'allow-nether', 'generate-structures',
  'hardcore', 'snooper-enabled', 'enable-rcon', 'enable-query', 'enable-jmx-monitoring',
  'sync-chunk-writes', 'enforce-secure-profile', 'enforce-whitelist', 'previews-chat',
  'hide-online-players', 'require-resource-pack', 'broadcast-rcon-to-ops', 'broadcast-console-to-ops'
]);

const VALID_DIFFICULTIES = new Set(['peaceful', 'easy', 'normal', 'hard']);
const VALID_GAMEMODES = new Set(['survival', 'creative', 'adventure', 'spectator']);

class FileManager {
  _validateName(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return false;
    if (/[\\\/]|\0/.test(trimmed)) return false;
    return true;
  }

  _calculateDirectorySize(dirPath) {
    let total = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += this._calculateDirectorySize(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      }
    } catch (e) {}
    return total;
  }

  _resolveSafePath(serverId, reqPath = '', requestUsername = null) {
    if (typeof reqPath !== 'string') {
      throw new Error('Geçersiz dosya yolu: Yol parametresi bir metin (string) olmalıdır.');
    }
    if (reqPath.includes('\0')) {
      throw new Error('Geçersiz dosya yolu: Yol boş bayt (NUL) karakteri içeremez.');
    }
    const trimmedReq = reqPath.trim();
    if (trimmedReq && (path.isAbsolute(trimmedReq) || trimmedReq.startsWith('/') || trimmedReq.startsWith('\\') || /^[a-zA-Z]:/.test(trimmedReq))) {
      throw new Error('Erişim reddedildi: Mutlak dosya yollarına izin verilmez.');
    }

    const server = serverRegistry.getById(serverId);
    if (!server) {
      throw new Error(`"${serverId}" kimlikli sunucu bulunamadı.`);
    }

    if (requestUsername && typeof requestUsername === 'string' && requestUsername.trim()) {
      const norm = requestUsername.trim().toLowerCase();
      if ((server.owner || '').toLowerCase() !== norm) {
        throw new Error('Erişim reddedildi: Bu sunucunun sahibi değilsiniz.');
      }
    }

    const serverRoot = path.resolve(server.directory);
    if (!fs.existsSync(serverRoot)) {
      throw new Error(`Sunucu kök dizini bulunamadı: ${serverRoot}`);
    }

    const realServerRoot = fs.realpathSync(serverRoot);
    const resolvedPath = path.resolve(serverRoot, trimmedReq);

    // Verify lexical path stays inside serverRoot
    const relFromRoot = path.relative(serverRoot, resolvedPath);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new Error('Erişim reddedildi: İstenen yol sunucu kök dizini dışındadır.');
    }

    // Verify realpath (symlinks) stay inside realServerRoot
    if (fs.existsSync(resolvedPath)) {
      try {
        const realResolved = fs.realpathSync(resolvedPath);
        const relReal = path.relative(realServerRoot, realResolved);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
          throw new Error('Erişim reddedildi: Sembolik bağ sunucu kök dizini dışına çıkıyor.');
        }
      } catch (e) {
        if (e.message.startsWith('Erişim reddedildi')) throw e;
      }
    } else {
      // If target does not exist yet, find nearest existing ancestor and verify its realpath stays inside realServerRoot
      let ancestor = path.dirname(resolvedPath);
      while (ancestor && ancestor !== path.dirname(ancestor)) {
        if (fs.existsSync(ancestor)) {
          try {
            const realAncestor = fs.realpathSync(ancestor);
            const relReal = path.relative(realServerRoot, realAncestor);
            if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
              throw new Error('Erişim reddedildi: Üst dizin sembolik bağı sunucu kök dizini dışına çıkıyor.');
            }
          } catch (e) {
            if (e.message.startsWith('Erişim reddedildi')) throw e;
          }
          break;
        }
        ancestor = path.dirname(ancestor);
      }
    }

    return { serverRoot, resolvedPath, relFromRoot };
  }

  isEditableFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return EDITABLE_EXTENSIONS.has(ext);
  }

  listFiles(serverId, reqPath = '') {
    const { serverRoot, resolvedPath, relFromRoot } = this._resolveSafePath(serverId, reqPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${reqPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${reqPath}`);
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    const result = entries.map((entry) => {
      const fullChild = path.join(resolvedPath, entry.name);
      let entryStat = null;
      try {
        entryStat = fs.statSync(fullChild);
      } catch (e) {
        // Fallback if permission error
      }

      const isDir = entryStat ? entryStat.isDirectory() : entry.isDirectory();
      const ext = isDir ? null : path.extname(entry.name).toLowerCase();
      const relChild = path.join(relFromRoot, entry.name).replace(/\\/g, '/');

      return {
        name: entry.name,
        path: relChild,
        isDirectory: isDir,
        type: isDir ? 'directory' : 'file',
        size: entryStat ? entryStat.size : 0,
        mtime: entryStat ? entryStat.mtime.toISOString() : null,
        extension: ext,
        isEditable: !isDir && this.isEditableFile(entry.name),
        isHidden: entry.name.startsWith('.')
      };
    });

    // Sort: directories first, then alphabetically
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    // Return array with attached properties for maximum backward and forward compatibility
    const list = [...result];
    list.currentPath = relFromRoot.replace(/\\/g, '/') || '';
    list.entries = result;
    return list;
  }

  readFileContent(serverId, reqPath) {
    const { resolvedPath } = this._resolveSafePath(serverId, reqPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Dosya bulunamadı: ${reqPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Cannot read directory as file (Dizinin içeriği dosya olarak okunamaz): ${reqPath}`);
    }

    if (stat.size > 10 * 1024 * 1024) {
      throw new Error(`Dosya tarayıcıda doğrudan düzenlemek için çok büyük (${(stat.size / 1024 / 1024).toFixed(1)} MB). Üst sınır 10 MB'dir.`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    return {
      path: reqPath,
      name: path.basename(resolvedPath),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      content
    };
  }

  writeFileContent(serverId, reqPath, content) {
    const { resolvedPath } = this._resolveSafePath(serverId, reqPath);

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      throw new Error(`Hedef yol bir dizindir: ${reqPath}`);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const existedBefore = fs.existsSync(resolvedPath);
    try {
      fs.writeFileSync(resolvedPath, content, 'utf8');
    } catch (err) {
      if (!existedBefore && fs.existsSync(resolvedPath)) {
        try { fs.unlinkSync(resolvedPath); } catch (e) {}
      }
      throw err;
    }
    const stat = fs.statSync(resolvedPath);

    return {
      success: true,
      message: 'Dosya başarıyla kaydedildi.',
      size: stat.size,
      mtime: stat.mtime.toISOString()
    };
  }

  deleteEntry(serverId, reqPath) {
    const { serverRoot, resolvedPath, relFromRoot } = this._resolveSafePath(serverId, reqPath);

    if (!relFromRoot || relFromRoot === '.' || relFromRoot === '') {
      throw new Error('Sunucu kök dizini silinemez.');
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Yol bulunamadı: ${reqPath}`);
    }

    fs.rmSync(resolvedPath, { recursive: true, force: true });
    return {
      success: true,
      message: `Başarıyla silindi: ${reqPath}`
    };
  }

  createFolder(serverId, parentRelPath, folderName) {
    if (!this._validateName(folderName)) {
      throw new Error('Geçersiz klasör adı: Yol ayırıcılar, boş baytlar içeremez ve "." ya da ".." olamaz.');
    }

    const targetSubPath = path.join(parentRelPath || '', folderName);
    const { resolvedPath } = this._resolveSafePath(serverId, targetSubPath);

    if (fs.existsSync(resolvedPath)) {
      throw new Error(`Klasör zaten mevcut: ${folderName}`);
    }

    fs.mkdirSync(resolvedPath, { recursive: true });
    return {
      success: true,
      message: `"${folderName}" klasörü başarıyla oluşturuldu.`,
      path: targetSubPath.replace(/\\/g, '/')
    };
  }

  createFile(serverId, parentRelPath, fileName, initialContent = '') {
    if (!this._validateName(fileName)) {
      throw new Error('Geçersiz dosya adı: Yol ayırıcılar, boş baytlar içeremez ve "." ya da ".." olamaz.');
    }

    const targetSubPath = path.join(parentRelPath || '', fileName);
    const { resolvedPath } = this._resolveSafePath(serverId, targetSubPath);

    if (fs.existsSync(resolvedPath)) {
      throw new Error(`Dosya zaten mevcut: ${fileName}`);
    }

    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    try {
      fs.writeFileSync(resolvedPath, initialContent, 'utf8');
    } catch (err) {
      if (fs.existsSync(resolvedPath)) {
        try { fs.unlinkSync(resolvedPath); } catch (e) {}
      }
      throw err;
    }
    return {
      success: true,
      message: `"${fileName}" dosyası başarıyla oluşturuldu.`,
      path: targetSubPath.replace(/\\/g, '/')
    };
  }

  renameEntry(serverId, oldRelPath, newName) {
    const { serverRoot, resolvedPath: oldResolved, relFromRoot } = this._resolveSafePath(serverId, oldRelPath);

    if (!relFromRoot || relFromRoot === '.' || relFromRoot === '') {
      throw new Error('Sunucu kök dizini yeniden adlandırılamaz.');
    }

    if (!fs.existsSync(oldResolved)) {
      throw new Error(`Yol bulunamadı: ${oldRelPath}`);
    }

    if (!this._validateName(newName)) {
      throw new Error('Geçersiz yeni ad: Yol ayırıcılar, boş baytlar içeremez ve "." ya da ".." olamaz.');
    }

    const newResolved = path.join(path.dirname(oldResolved), newName);
    if (fs.existsSync(newResolved)) {
      throw new Error(`"${newName}" adında bir öğe zaten mevcut.`);
    }

    // Verify destination stays inside realServerRoot
    const realServerRoot = fs.realpathSync(serverRoot);
    const relNew = path.relative(serverRoot, newResolved);
    if (relNew.startsWith('..') || path.isAbsolute(relNew)) {
      throw new Error('Erişim reddedildi: Yeni hedef sunucu kök dizini dışındadır.');
    }
    const parentDir = path.dirname(newResolved);
    if (fs.existsSync(parentDir)) {
      const realParent = fs.realpathSync(parentDir);
      const relParent = path.relative(realServerRoot, realParent);
      if (relParent.startsWith('..') || path.isAbsolute(relParent)) {
        throw new Error('Erişim reddedildi: Hedefin üst dizini sunucu kök dizini dışına çıkıyor.');
      }
    }

    fs.renameSync(oldResolved, newResolved);
    return {
      success: true,
      message: 'Öğe başarıyla yeniden adlandırıldı.'
    };
  }

  pipeDirectoryDownload(serverId, reqPath, res) {
    const { serverRoot, resolvedPath } = this._resolveSafePath(serverId, reqPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Dosya veya dizin bulunamadı: ${reqPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      const baseName = path.basename(resolvedPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', formatContentDisposition(baseName));
      return fs.createReadStream(resolvedPath).pipe(res);
    }

    const folderName = path.basename(resolvedPath) || 'server-archive';
    const filename = `${folderName}.tar.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', formatContentDisposition(filename));

    const parentDir = path.dirname(resolvedPath);
    const baseName = path.basename(resolvedPath);
    const operand = baseName.startsWith('-') ? `./${baseName}` : baseName;

    // Stream directly via tar -czf - with array arguments and no shell, guarded by '--'
    const child = spawn('tar', ['--no-same-owner', '-czf', '-', '--', operand], {
      cwd: parentDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.pipe(res);

    child.on('error', (err) => {
      console.error('[FileManager] Tar akış hatası:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Arşiv akışı sırasında hata oluştu: ' + err.message });
      }
    });

    res.on('close', () => {
      if (!child.killed) {
        try { child.kill('SIGTERM'); } catch (e) {}
      }
    });
  }

  getDownloadItem(serverId, reqPath, res = null) {
    const { resolvedPath } = this._resolveSafePath(serverId, reqPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Dosya bulunamadı: ${reqPath}`);
    }

    // Direct HTTP response streaming mode when res is provided
    if (res) {
      return this.pipeDirectoryDownload(serverId, reqPath, res);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      const folderName = path.basename(resolvedPath) || 'server-archive';
      const tempTarPath = path.join(os.tmpdir(), `${folderName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tar.gz`);
      const parentDir = path.dirname(resolvedPath);
      const baseName = path.basename(resolvedPath);
      const operand = baseName.startsWith('-') ? `./${baseName}` : baseName;

      // Spawn tar to create streamable archive on disk without loading entire archive to RAM
      const { spawnSync } = require('child_process');
      const result = spawnSync('tar', ['--no-same-owner', '-czf', tempTarPath, '--', operand], {
        cwd: parentDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });

      if (result.status === 0 && fs.existsSync(tempTarPath)) {
        // Schedule cleanup after download completes (30 minutes safety window)
        setTimeout(() => {
          try { if (fs.existsSync(tempTarPath)) fs.unlinkSync(tempTarPath); } catch (e) {}
        }, 30 * 60 * 1000).unref?.();

        return {
          type: 'file',
          filename: `${folderName}.tar.gz`,
          filePath: tempTarPath
        };
      }

      // Fallback in case tar is unavailable
      const zip = new AdmZip();
      zip.addLocalFolder(resolvedPath);
      const zipBuffer = zip.toBuffer();
      return {
        type: 'buffer',
        filename: `${folderName}.zip`,
        contentType: 'application/zip',
        data: zipBuffer
      };
    } else {
      return {
        type: 'file',
        filename: path.basename(resolvedPath),
        filePath: resolvedPath
      };
    }
  }

  getServerProperties(serverId) {
    const server = serverRegistry.getById(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    const propsPath = path.join(server.directory, 'server.properties');
    const rawProps = {};
    if (fs.existsSync(propsPath)) {
      const content = fs.readFileSync(propsPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          rawProps[key] = val;
        }
      }
    }

    // Comprehensive defaults according to Minecraft server specifications
    const defaults = {
      'motd': server.name ? `${server.name} Minecraft Server` : 'A Minecraft Server',
      'server-port': String(server.port || 25565),
      'max-players': String(server.maxPlayers || '10'),
      'difficulty': 'normal',
      'gamemode': 'survival',
      'pvp': 'true',
      'white-list': 'false',
      'online-mode': 'true',
      'view-distance': '10',
      'simulation-distance': '10',
      'spawn-protection': '16',
      'allow-flight': 'false',
      'level-name': 'world',
      'level-seed': '',
      'enable-command-block': 'false',
      'spawn-animals': 'true',
      'spawn-monsters': 'true',
      'spawn-npcs': 'true'
    };

    const merged = { ...defaults, ...rawProps };

    const toBool = (val, def = false) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return def;
    };

    const toInt = (val, def = 0) => {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? def : parsed;
    };

    return {
      serverId,
      raw: merged,
      motd: merged['motd'],
      serverPort: toInt(merged['server-port'], server.port || 25565),
      maxPlayers: toInt(merged['max-players'], server.maxPlayers || 10),
      difficulty: merged['difficulty'] || 'normal',
      gamemode: merged['gamemode'] || 'survival',
      pvp: toBool(merged['pvp'], true),
      whiteList: toBool(merged['white-list'], false),
      onlineMode: toBool(merged['online-mode'], true),
      viewDistance: toInt(merged['view-distance'], 10),
      simulationDistance: toInt(merged['simulation-distance'], 10),
      spawnProtection: toInt(merged['spawn-protection'], 16),
      allowFlight: toBool(merged['allow-flight'], false),
      levelName: merged['level-name'] || 'world',
      levelSeed: merged['level-seed'] || '',
      enableCommandBlock: toBool(merged['enable-command-block'], false),
      spawnAnimals: toBool(merged['spawn-animals'], true),
      spawnMonsters: toBool(merged['spawn-monsters'], true),
      spawnNpcs: toBool(merged['spawn-npcs'], true)
    };
  }

  saveServerProperties(serverId, updates = {}) {
    const server = serverRegistry.getById(serverId);
    if (!server) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    const propsPath = path.join(server.directory, 'server.properties');
    let lines = [];
    const existingMap = new Map();

    if (fs.existsSync(propsPath)) {
      const content = fs.readFileSync(propsPath, 'utf8');
      lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          existingMap.set(key, true);
        }
      }
    } else {
      lines = [
        '#Minecraft server properties',
        '#Generated and managed by maziPanel'
      ];
    }

    // Map aliases
    const keyMap = {
      motd: 'motd',
      serverPort: 'server-port',
      port: 'server-port',
      'server-port': 'server-port',
      maxPlayers: 'max-players',
      'max-players': 'max-players',
      difficulty: 'difficulty',
      gamemode: 'gamemode',
      pvp: 'pvp',
      whiteList: 'white-list',
      whitelist: 'white-list',
      'white-list': 'white-list',
      onlineMode: 'online-mode',
      'online-mode': 'online-mode',
      viewDistance: 'view-distance',
      'view-distance': 'view-distance',
      simulationDistance: 'simulation-distance',
      'simulation-distance': 'simulation-distance',
      spawnProtection: 'spawn-protection',
      'spawn-protection': 'spawn-protection',
      allowFlight: 'allow-flight',
      'allow-flight': 'allow-flight',
      levelName: 'level-name',
      'level-name': 'level-name',
      levelSeed: 'level-seed',
      'level-seed': 'level-seed',
      enableCommandBlock: 'enable-command-block',
      commandBlocks: 'enable-command-block',
      'enable-command-block': 'enable-command-block',
      spawnAnimals: 'spawn-animals',
      'spawn-animals': 'spawn-animals',
      spawnMonsters: 'spawn-monsters',
      'spawn-monsters': 'spawn-monsters',
      spawnNpcs: 'spawn-npcs',
      'spawn-npcs': 'spawn-npcs'
    };

    const normalizedUpdates = {};
    const processEntry = (rawK, rawV) => {
      if (rawK === null || rawK === undefined) return;
      const targetKey = keyMap[rawK] || rawK;

      if (typeof targetKey !== 'string' || !SAFE_PROPERTY_KEY_REGEX.test(targetKey) || NEWLINE_OR_NUL_REGEX.test(targetKey)) {
        throw new Error(`Geçersiz özellik anahtarı: "${targetKey}". Anahtar yalnızca harf, rakam, nokta, alt çizgi ve tire içerebilir.`);
      }

      let valStr;
      if (typeof rawV === 'boolean') {
        valStr = rawV ? 'true' : 'false';
      } else if (rawV === null || rawV === undefined) {
        valStr = '';
      } else {
        valStr = String(rawV);
      }

      if (NEWLINE_OR_NUL_REGEX.test(valStr)) {
        throw new Error(`Geçersiz özellik değeri: "${targetKey}" değeri satır sonu veya boş bayt karakteri içeremez.`);
      }

      if (KNOWN_BOOLEAN_KEYS.has(targetKey)) {
        const lower = valStr.trim().toLowerCase();
        if (lower !== 'true' && lower !== 'false') {
          throw new Error(`"${targetKey}" özelliği için yalnızca "true" veya "false" değeri verilebilir.`);
        }
        valStr = lower;
      }

      if (KNOWN_PROPERTY_RANGES[targetKey]) {
        const conf = KNOWN_PROPERTY_RANGES[targetKey];
        const trimmed = valStr.trim();
        const num = Number(trimmed);
        if (!/^-?\d+$/.test(trimmed) || !Number.isInteger(num) || num < conf.min || num > conf.max) {
          throw new Error(`${conf.label} değeri ${conf.min} ile ${conf.max} arasında bir tam sayı olmalıdır.`);
        }
        valStr = String(num);
      }

      if (targetKey === 'difficulty') {
        const lower = valStr.trim().toLowerCase();
        if (!VALID_DIFFICULTIES.has(lower)) {
          throw new Error('Geçersiz zorluk derecesi: "peaceful", "easy", "normal" veya "hard" olmalıdır.');
        }
        valStr = lower;
      }

      if (targetKey === 'gamemode') {
        const lower = valStr.trim().toLowerCase();
        if (!VALID_GAMEMODES.has(lower)) {
          throw new Error('Geçersiz oyun modu: "survival", "creative", "adventure" veya "spectator" olmalıdır.');
        }
        valStr = lower;
      }

      normalizedUpdates[targetKey] = valStr;
    };

    if (updates && typeof updates === 'object') {
      for (const [k, v] of Object.entries(updates)) {
        if (k === 'raw' && typeof v === 'object' && v !== null) {
          for (const [rk, rv] of Object.entries(v)) {
            processEntry(rk, rv);
          }
          continue;
        }
        processEntry(k, v);
      }
    }

    // Update lines in place where key exists
    const updatedKeys = new Set();
    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        if (Object.prototype.hasOwnProperty.call(normalizedUpdates, key)) {
          updatedKeys.add(key);
          return `${key}=${normalizedUpdates[key]}`;
        }
      }
      return line;
    });

    // Append any keys that weren't in the original file
    for (const [key, val] of Object.entries(normalizedUpdates)) {
      if (!updatedKeys.has(key)) {
        newLines.push(`${key}=${val}`);
      }
    }

    const tempPropsPath = `${propsPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(tempPropsPath, newLines.join('\n') + '\n', 'utf8');
      fs.renameSync(tempPropsPath, propsPath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPropsPath)) fs.unlinkSync(tempPropsPath);
      } catch (e) {}
      throw err;
    }

    // If port was modified, sync with serverRegistry
    if (normalizedUpdates['server-port']) {
      const newPort = parseInt(normalizedUpdates['server-port'], 10);
      if (!isNaN(newPort) && newPort >= 1024 && newPort <= 65535) {
        serverRegistry.update(serverId, { port: newPort });
      }
    }

    // If max-players was modified, sync with serverRegistry
    if (normalizedUpdates['max-players']) {
      const newMax = parseInt(normalizedUpdates['max-players'], 10);
      if (!isNaN(newMax) && newMax >= 1 && newMax <= 1000) {
        serverRegistry.update(serverId, { maxPlayers: newMax });
      }
    }

    return this.getServerProperties(serverId);
  }
}

module.exports = new FileManager();
