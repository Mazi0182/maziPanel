const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const config = require('../../config');
const serverRegistry = require('./serverRegistry');
const processManager = require('./processManager');
const archiveBrowser = require('../backups/archiveBrowser');
const incrementalEngine = require('../backups/incremental');
const { validateAndExtractZip, extractTarSafely } = require('./archiveSecurity');

const BACKUPS_INDEX_FILE = path.join(config.DATA_DIR, 'backups.json');

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function slugifyTurkish(str) {
  if (!str) return '';
  const trMap = {
    'ç': 'c', 'Ç': 'C',
    'ğ': 'g', 'Ğ': 'G',
    'ı': 'i', 'I': 'I', 'İ': 'I',
    'ö': 'o', 'Ö': 'O',
    'ş': 's', 'Ş': 'S',
    'ü': 'u', 'Ü': 'U'
  };
  return String(str)
    .replace(/[çÇğĞıIİöÖşŞüÜ]/g, (char) => trMap[char] || char)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getIstanbulTimestampString(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}_${m.hour}-${m.minute}`;
}

function sanitizeExclusions(exclusions, defaultExclusions = ['logs', 'crash-reports']) {
  return incrementalEngine.sanitizeExclusions(exclusions, defaultExclusions);
}

function matchesExclusion(relPath, exclusions) {
  return incrementalEngine.matchesExclusion(relPath, exclusions);
}

function hasCommand(cmd) {
  try {
    const res = spawnSync('which', [cmd], { stdio: 'pipe' });
    return res.status === 0;
  } catch {
    return false;
  }
}

class BackupManager {
  constructor() {
    this.activeServerLocks = processManager.activeServerLocks;
    this._load();
  }

  _load() {
    if (!fs.existsSync(BACKUPS_INDEX_FILE)) {
      this.backups = [];
      this._save();
      return;
    }
    try {
      const data = fs.readFileSync(BACKUPS_INDEX_FILE, 'utf8');
      this.backups = JSON.parse(data);
    } catch (err) {
      console.error('backups.json okunamadı, boş liste ile başlatılıyor:', err.message);
      this.backups = [];
    }
  }

  _save() {
    try {
      const tmpFile = `${BACKUPS_INDEX_FILE}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.backups, null, 2), 'utf8');
      fs.renameSync(tmpFile, BACKUPS_INDEX_FILE);
    } catch (err) {
      console.error('backups.json kaydedilemedi:', err.message);
    }
  }

  listBackups(serverId = null, requestUsername = null) {
    this._load();
    let list = this.backups;

    if (requestUsername && typeof requestUsername === 'string' && requestUsername.trim()) {
      const allowedServers = serverRegistry.getAll(requestUsername.trim().toLowerCase());
      const allowedIds = new Set(allowedServers.map((s) => s.id));
      list = list.filter((b) => allowedIds.has(b.serverId));
    }

    if (serverId) {
      list = list.filter((b) => b.serverId === serverId);
    }

    return list.map((b) => {
      const exists = fs.existsSync(b.filePath);
      let sizeBytes = b.sizeBytes || 0;
      if (exists) {
        try {
          sizeBytes = fs.statSync(b.filePath).size;
        } catch {}
      }
      return {
        ...b,
        exists,
        sizeBytes,
        sizeFormatted: formatBytes(sizeBytes)
      };
    });
  }

  getBackupById(backupId) {
    this._load();
    const backup = this.backups.find((b) => b.id === backupId);
    if (!backup) return null;
    const exists = fs.existsSync(backup.filePath);
    let sizeBytes = backup.sizeBytes || 0;
    if (exists) {
      try {
        sizeBytes = fs.statSync(backup.filePath).size;
      } catch {}
    }
    return {
      ...backup,
      exists,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes)
    };
  }

  async createBackup(serverId, options = {}) {
    this._load();

    const server = serverRegistry.getById(serverId);
    if (!server) {
      throw new Error(`Server with ID "${serverId}" not found (ID değeri "${serverId}" olan sunucu bulunamadı).`);
    }

    // Validate exclusions upfront before acquiring lock or touching disk
    const exclusions = sanitizeExclusions(options.exclusions);

    // Acquire per-server concurrency lock
    processManager.acquireServerLock(serverId, 'backup', 'Yedekleme');

    try {
      const safeServerDir = serverRegistry.assertSafeServerDirectory(server.directory, server.id);
      if (!fs.existsSync(safeServerDir)) {
        throw new Error(`Sunucu dizini diskte bulunamadı: ${safeServerDir}`);
      }

      // Target destination directory strictly confined under config.BACKUPS_DIR
      const baseBackupsDir = path.resolve(config.BACKUPS_DIR);
      if (!fs.existsSync(baseBackupsDir)) {
        fs.mkdirSync(baseBackupsDir, { recursive: true });
      }
      const realBaseBackupsDir = fs.realpathSync(baseBackupsDir);

      let targetDestDir;
      if (options.destDir) {
        const resolvedDestDir = path.resolve(options.destDir);
        const isInsideBase = resolvedDestDir === baseBackupsDir || resolvedDestDir.startsWith(baseBackupsDir + path.sep);
        if (!isInsideBase) {
          throw new Error('Destination directory is not permitted: Yedek hedef dizini izin verilen yedekleme konumu (BACKUPS_DIR) dışında olamaz.');
        }

        // Check realpath against symlink breakout
        let ancestor = resolvedDestDir;
        while (ancestor && !fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
          ancestor = path.dirname(ancestor);
        }
        if (fs.existsSync(ancestor)) {
          const realAncestor = fs.realpathSync(ancestor);
          const isInsideReal = realAncestor === realBaseBackupsDir || realAncestor.startsWith(realBaseBackupsDir + path.sep);
          if (!isInsideReal) {
            throw new Error('Yedek hedef dizini sembolik bağ üzerinden izin verilen yedekleme konumu dışına çıkamaz.');
          }
        }
        targetDestDir = resolvedDestDir;
      } else {
        targetDestDir = path.join(baseBackupsDir, serverId);
      }

      if (!fs.existsSync(targetDestDir)) {
        fs.mkdirSync(targetDestDir, { recursive: true });
      }

      // Determine format and compression level
      // Accept either 'format' or legacy 'compression'
      let format = 'zip';
      if (options.format) {
        const f = String(options.format).toLowerCase().trim();
        if (['zip', 'tar.gz', 'tar'].includes(f)) {
          format = f;
        }
      } else if (options.compression) {
        const c = String(options.compression).toLowerCase().trim();
        if (c === 'gzip') format = 'tar.gz';
        else if (c === 'none' || c === 'tar') format = 'tar';
        else if (c === 'zip') format = 'zip';
      }

      const singleFile = Boolean(options.singleFile);
      if (singleFile && format !== 'zip') {
        console.warn('[BackupManager] Tek dosya modu için zip dışı format istendi. Format zip olarak ayarlanıyor.');
        format = 'zip';
      }

      const level = Math.max(0, Math.min(9, parseInt(options.level, 10) !== undefined && !isNaN(parseInt(options.level, 10)) ? parseInt(options.level, 10) : 6));

      // Safe base name from user's custom name or server name
      const rawName = (options.name && String(options.name).trim()) || server.name || serverId;
      let safeBaseName = slugifyTurkish(rawName) || 'backup';
      if (safeBaseName.length > 50) {
        safeBaseName = safeBaseName.slice(0, 50);
      }

      let ext = '.zip';
      if (format === 'tar.gz') ext = '.tar.gz';
      else if (format === 'tar') ext = '.tar';

      // File name determination
      let filename;
      let targetFilePath;

      let matchedTargetRecord = null;
      if (singleFile) {
        if (options.targetBackupId) {
          matchedTargetRecord = this.backups.find(
            (b) => b.serverId === serverId && b.id === String(options.targetBackupId).trim()
          );
        }
        if (matchedTargetRecord && matchedTargetRecord.filename && matchedTargetRecord.filename.toLowerCase().endsWith('.zip')) {
          filename = path.basename(matchedTargetRecord.filename);
          targetFilePath = path.join(targetDestDir, filename);
        } else if (options.targetFilename && String(options.targetFilename).trim()) {
          let cleanTarget = path.basename(String(options.targetFilename).trim());
          if (!cleanTarget.toLowerCase().endsWith('.zip')) cleanTarget += '.zip';
          filename = cleanTarget;
          targetFilePath = path.join(targetDestDir, filename);
        } else {
          // If no explicit targetBackupId was given and no custom name was typed, reuse existing singleFile backup for this server if present
          const existingSingle = !(options.name && String(options.name).trim())
            ? this.backups.find(
                (b) =>
                  b.serverId === serverId &&
                  b.singleFile === true &&
                  b.filename &&
                  b.filename.toLowerCase().endsWith('.zip') &&
                  fs.existsSync(b.filePath)
              )
            : null;
          if (existingSingle) {
            matchedTargetRecord = existingSingle;
            filename = path.basename(existingSingle.filename);
            targetFilePath = path.join(targetDestDir, filename);
          } else {
            // Single file mode: constant filename without timestamp
            filename = `${safeBaseName}.zip`;
            targetFilePath = path.join(targetDestDir, filename);
          }
        }
      } else {
        // Standard mode: <safeBaseName>_<YYYY-MM-DD_HH-mm>.<ext> with conflict handling (-2, -3)
        const timestamp = getIstanbulTimestampString(new Date());
        let candidateFilename = `${safeBaseName}_${timestamp}${ext}`;
        let candidatePath = path.join(targetDestDir, candidateFilename);

        if (fs.existsSync(candidatePath)) {
          let counter = 2;
          while (fs.existsSync(path.join(targetDestDir, `${safeBaseName}_${timestamp}-${counter}${ext}`))) {
            counter++;
          }
          candidateFilename = `${safeBaseName}_${timestamp}-${counter}${ext}`;
          candidatePath = path.join(targetDestDir, candidateFilename);
        }

        filename = candidateFilename;
        targetFilePath = candidatePath;
      }

      const backupId = `bck-${serverId}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
      const nowIso = new Date().toISOString();

      // Check if server is running; if so, trigger save-off and save-all flush
      const status = processManager.getStatus(serverId);
      const isOnline = status && ['online', 'starting'].includes(status.status);

      if (isOnline) {
        try {
          console.log(`[BackupManager] "${serverId}" sunucusuna save-off ve save-all flush gönderiliyor...`);
          processManager.sendCommand(serverId, 'save-off');
          processManager.sendCommand(serverId, 'save-all flush');
          // Wait 2.5 seconds for flush to complete on disk
          await new Promise((resolve) => setTimeout(resolve, 2500));
        } catch (err) {
          console.warn(`[BackupManager] "${serverId}" sunucusuna kaydetme komutları gönderilemedi:`, err.message);
        }
      }

      let stats = null;

      try {
        if (singleFile) {
          // Execute incremental single file backup
          const incResult = incrementalEngine.syncBackup(safeServerDir, targetFilePath, {
            exclusions,
            level
          });
          stats = incResult.stats;
        } else {
          // Normal backup
          const startTime = Date.now();
          if (format === 'zip') {
            if (hasCommand('zip')) {
              // Use system Info-ZIP
              const zipArgs = ['-r', `-${level}`, targetFilePath];
              for (const exc of exclusions) {
                const cleanExc = String(exc).trim().replace(/\\/g, '/');
                if (cleanExc && !cleanExc.startsWith('-')) {
                  zipArgs.push('-x', `${cleanExc}*`, `*/${cleanExc}*`);
                }
              }
              zipArgs.push('--', '.');
              const res = spawnSync('zip', zipArgs, {
                cwd: safeServerDir,
                stdio: 'pipe',
                encoding: 'utf8'
              });
              if (res.status !== 0 && !fs.existsSync(targetFilePath)) {
                throw new Error(`Sistem 'zip' komutu hata verdi (kod ${res.status}): ${res.stderr || res.stdout}`);
              }
            } else {
              // AdmZip fallback
              console.warn('[BackupManager] Sistemde zip komutu bulunamadı, AdmZip yedek yöntemi kullanılıyor.');
              const zip = new AdmZip();
              const addDirectoryContents = (dirPath, relBase = '') => {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                  const fullPath = path.join(dirPath, entry.name);
                  const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
                  if (matchesExclusion(relPath, exclusions)) continue;
                  if (entry.isDirectory()) {
                    addDirectoryContents(fullPath, relPath);
                  } else if (entry.isFile()) {
                    zip.addFile(relPath, fs.readFileSync(fullPath));
                  }
                }
              };
              addDirectoryContents(safeServerDir);
              zip.writeZip(targetFilePath);
            }
          } else if (format === 'tar.gz') {
            // tar -I 'gzip -<level>' -cf targetFilePath ...
            const tarFlags = ['-I', `gzip -${level}`, '-cf', targetFilePath];
            for (const exc of exclusions) {
              const cleanExc = String(exc).trim();
              if (cleanExc && !cleanExc.startsWith('-')) tarFlags.push(`--exclude=${cleanExc}`);
            }
            tarFlags.push('-C', safeServerDir, '--', '.');

            const res = spawnSync('tar', tarFlags, { stdio: 'pipe' });
            if (res.status !== 0 && !fs.existsSync(targetFilePath)) {
              // Try standard tar -czf fallback if -I failed
              const fallbackFlags = ['-czf', targetFilePath];
              for (const exc of exclusions) {
                const cleanExc = String(exc).trim();
                if (cleanExc && !cleanExc.startsWith('-')) fallbackFlags.push(`--exclude=${cleanExc}`);
              }
              fallbackFlags.push('-C', safeServerDir, '--', '.');
              const res2 = spawnSync('tar', fallbackFlags, { stdio: 'pipe' });
              if (res2.status !== 0 && !fs.existsSync(targetFilePath)) {
                throw new Error(`tar.gz oluşturma başarısız oldu: ${res.stderr?.toString() || res2.stderr?.toString()}`);
              }
            }
          } else if (format === 'tar') {
            const tarFlags = ['-cf', targetFilePath];
            for (const exc of exclusions) {
              const cleanExc = String(exc).trim();
              if (cleanExc && !cleanExc.startsWith('-')) tarFlags.push(`--exclude=${cleanExc}`);
            }
            tarFlags.push('-C', safeServerDir, '--', '.');

            const res = spawnSync('tar', tarFlags, { stdio: 'pipe' });
            if (res.status !== 0 && !fs.existsSync(targetFilePath)) {
              throw new Error(`tar oluşturma başarısız oldu: ${res.stderr?.toString()}`);
            }
          }

          const durationMs = Date.now() - startTime;
          stats = {
            durationMs
          };
        }

        if (!fs.existsSync(targetFilePath)) {
          throw new Error('Yedek arşivi diske yazılamadı.');
        }

        const stat = fs.statSync(targetFilePath);
        const displayName = (options.name && String(options.name).trim()) || `${server.name} Yedegi - ${new Date().toLocaleDateString('tr-TR')}`;

        // If single file, check if an existing record should be updated
        let existingRecord = null;
        if (singleFile) {
          existingRecord =
            matchedTargetRecord ||
            this.backups.find((b) => b.serverId === serverId && b.filePath === targetFilePath);
        }

        let record;
        if (existingRecord) {
          if (options.name && String(options.name).trim()) {
            existingRecord.name = String(options.name).trim();
          }
          existingRecord.filename = filename;
          existingRecord.filePath = targetFilePath;
          existingRecord.format = 'zip';
          existingRecord.compression = 'zip';
          existingRecord.level = level;
          existingRecord.exclusions = exclusions;
          existingRecord.singleFile = true;
          existingRecord.sizeBytes = stat.size;
          existingRecord.sizeFormatted = formatBytes(stat.size);
          existingRecord.updatedAt = nowIso;
          existingRecord.stats = stats || existingRecord.stats;
          existingRecord.exists = true;
          record = existingRecord;
        } else {
          record = {
            id: backupId,
            serverId,
            serverName: server.name,
            name: displayName,
            filename,
            filePath: targetFilePath,
            destDir: targetDestDir,
            format,
            level,
            compression: format === 'tar.gz' ? 'gzip' : (format === 'tar' ? 'none' : 'zip'),
            exclusions,
            sizeBytes: stat.size,
            sizeFormatted: formatBytes(stat.size),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: options.source || 'manual',
            singleFile,
            stats: stats || undefined,
            exists: true
          };
          this.backups.unshift(record);
        }

        this._save();
        return record;
      } finally {
        // Always restore save-on if server was running
        if (isOnline) {
          try {
            console.log(`[BackupManager] "${serverId}" sunucusuna save-on gönderiliyor...`);
            processManager.sendCommand(serverId, 'save-on');
          } catch (err) {
            console.warn(`[BackupManager] "${serverId}" sunucusuna save-on gönderilemedi:`, err.message);
          }
        }
      }
    } finally {
      processManager.releaseServerLock(serverId, 'backup');
    }
  }

  async restoreBackup(serverId, backupId, options = {}) {
    this._load();

    const backup = this.backups.find((b) => b.id === backupId);
    if (!backup) {
      throw new Error(`ID değeri "${backupId}" olan yedek bulunamadı.`);
    }

    if (serverId && backup.serverId && backup.serverId !== serverId) {
      throw new Error(`Backup "${backupId}" does not belong to server "${serverId}" ("${backupId}" kimlikli yedek "${serverId}" sunucusuna ait değil).`);
    }

    const targetServerId = serverId || backup.serverId;
    const server = serverRegistry.getById(targetServerId);
    if (!server) {
      throw new Error(`ID değeri "${targetServerId}" olan sunucu bulunamadı.`);
    }

    if (!fs.existsSync(backup.filePath)) {
      throw new Error(`Yedek dosyası diskte bulunamadı: ${backup.filePath}`);
    }

    processManager.acquireServerLock(targetServerId, 'restore', 'Yedek geri yükleme');

    try {
      const safeServerDir = serverRegistry.assertSafeServerDirectory(server.directory, targetServerId);
      if (!fs.existsSync(safeServerDir)) {
        fs.mkdirSync(safeServerDir, { recursive: true });
      }

      // Server running safety check
      const status = processManager.getStatus(targetServerId);
      if (status && ['online', 'starting'].includes(status.status)) {
        if (options.forceStop) {
          await processManager.stopServer(targetServerId, 10000);
        } else {
          throw new Error('Sunucu şu anda çalışıyor. Lütfen yedeği geri yüklemeden önce sunucuyu durdurun veya forceStop seçeneğini kullanın.');
        }
      }

      const format = backup.format || (backup.filePath.endsWith('.zip') ? 'zip' : (backup.filePath.endsWith('.tar.gz') ? 'tar.gz' : 'tar'));

      if (format === 'zip' || backup.filePath.endsWith('.zip')) {
        validateAndExtractZip(backup.filePath, safeServerDir);
      } else {
        const isGzip = format === 'tar.gz' || backup.filePath.endsWith('.gz') || backup.filePath.endsWith('.tgz');
        extractTarSafely(backup.filePath, safeServerDir, { isGzip });
      }

      return {
        success: true,
        message: 'Yedek başarıyla geri yüklendi.',
        backupId,
        serverId: targetServerId
      };
    } finally {
      processManager.releaseServerLock(targetServerId, 'restore');
    }
  }

  deleteBackup(backupId, serverId = null) {
    this._load();
    const index = this.backups.findIndex((b) => b.id === backupId);
    if (index === -1) {
      throw new Error(`ID değeri "${backupId}" olan yedek bulunamadı.`);
    }

    const backup = this.backups[index];
    if (serverId && backup.serverId && backup.serverId !== serverId) {
      throw new Error(`Backup "${backupId}" does not belong to server "${serverId}" ("${backupId}" kimlikli yedek "${serverId}" sunucusuna ait değil).`);
    }

    if (fs.existsSync(backup.filePath)) {
      try {
        fs.unlinkSync(backup.filePath);
        // Also remove manifest if exists
        const manifestPath = `${backup.filePath}.manifest.json`;
        if (fs.existsSync(manifestPath)) {
          fs.unlinkSync(manifestPath);
        }

        const parentDir = path.dirname(backup.filePath);
        if (parentDir.startsWith(path.resolve(config.BACKUPS_DIR)) && parentDir !== path.resolve(config.BACKUPS_DIR)) {
          const remaining = fs.readdirSync(parentDir);
          if (remaining.length === 0) {
            fs.rmdirSync(parentDir);
          }
        }
      } catch (err) {
        console.warn(`Yedek dosyası silinemedi (${backup.filePath}):`, err.message);
      }
    }

    this.backups.splice(index, 1);
    this._save();

    return {
      success: true,
      message: 'Yedek başarıyla silindi.',
      backupId
    };
  }

  // --- Archive Inspection Methods (WinRAR style) ---

  getBackupEntries(backupId, reqPath = '') {
    const backup = this.getBackupById(backupId);
    if (!backup) {
      throw new Error(`Yedek bulunamadı: ${backupId}`);
    }
    if (!backup.exists || !fs.existsSync(backup.filePath)) {
      throw new Error(`Yedek dosyası diskte bulunamadı: ${backup.filePath}`);
    }

    // Realpath containment check inside BACKUPS_DIR
    const baseBackupsDir = path.resolve(config.BACKUPS_DIR);
    if (fs.existsSync(baseBackupsDir)) {
      const realBaseBackupsDir = fs.realpathSync(baseBackupsDir);
      const realBackupPath = fs.realpathSync(backup.filePath);
      const relReal = path.relative(realBaseBackupsDir, realBackupPath);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new Error('Erişim reddedildi: Sembolik bağ izin verilen yedekleme dizini dışına çıkıyor.');
      }
    }

    return archiveBrowser.listDirectoryChildren(backup.filePath, reqPath);
  }

  async getBackupEntry(backupId, reqPath, options = {}) {
    const backup = this.getBackupById(backupId);
    if (!backup) {
      throw new Error(`Yedek bulunamadı: ${backupId}`);
    }
    if (!backup.exists || !fs.existsSync(backup.filePath)) {
      throw new Error(`Yedek dosyası diskte bulunamadı: ${backup.filePath}`);
    }

    // Realpath containment check inside BACKUPS_DIR
    const baseBackupsDir = path.resolve(config.BACKUPS_DIR);
    if (fs.existsSync(baseBackupsDir)) {
      const realBaseBackupsDir = fs.realpathSync(baseBackupsDir);
      const realBackupPath = fs.realpathSync(backup.filePath);
      const relReal = path.relative(realBaseBackupsDir, realBackupPath);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new Error('Erişim reddedildi: Sembolik bağ izin verilen yedekleme dizini dışına çıkıyor.');
      }
    }

    return archiveBrowser.readEntry(backup.filePath, reqPath, options);
  }

  getServerArchiveEntries(serverId, relFile, reqPath = '') {
    if (!serverId) throw new Error('serverId parametresi zorunludur.');
    if (!relFile) throw new Error('file parametresi zorunludur.');

    const server = serverRegistry.getById(serverId);
    if (!server) throw new Error(`Sunucu bulunamadı: ${serverId}`);

    const resolvedServerDir = path.resolve(server.directory);
    if (!fs.existsSync(resolvedServerDir)) {
      throw new Error(`Sunucu dizini bulunamadı: ${server.directory}`);
    }
    const realServerDir = fs.realpathSync(resolvedServerDir);

    const resolvedFile = path.resolve(server.directory, relFile);

    // Lexical path traversal check
    const relFromRoot = path.relative(resolvedServerDir, resolvedFile);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new Error('Geçersiz dosya konumu (Path Traversal engellendi).');
    }

    if (!fs.existsSync(resolvedFile)) {
      throw new Error(`Arşiv dosyası bulunamadı: ${relFile}`);
    }

    // Realpath containment check against symlinks escaping server directory
    const realResolvedFile = fs.realpathSync(resolvedFile);
    const relReal = path.relative(realServerDir, realResolvedFile);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error('Erişim reddedildi: Sembolik bağ sunucu dizini dışına çıkıyor.');
    }

    const type = archiveBrowser.getArchiveType(resolvedFile);
    if (!type) {
      throw new Error('Belirtilen dosya desteklenen bir arşiv formatı değil (.zip, .jar, .tar, .tar.gz, .tgz).');
    }

    return archiveBrowser.listDirectoryChildren(resolvedFile, reqPath);
  }

  async getServerArchiveEntry(serverId, relFile, reqPath, options = {}) {
    if (!serverId) throw new Error('serverId parametresi zorunludur.');
    if (!relFile) throw new Error('file parametresi zorunludur.');

    const server = serverRegistry.getById(serverId);
    if (!server) throw new Error(`Sunucu bulunamadı: ${serverId}`);

    const resolvedServerDir = path.resolve(server.directory);
    if (!fs.existsSync(resolvedServerDir)) {
      throw new Error(`Sunucu dizini bulunamadı: ${server.directory}`);
    }
    const realServerDir = fs.realpathSync(resolvedServerDir);

    const resolvedFile = path.resolve(server.directory, relFile);

    // Lexical path traversal check
    const relFromRoot = path.relative(resolvedServerDir, resolvedFile);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new Error('Geçersiz dosya konumu (Path Traversal engellendi).');
    }

    if (!fs.existsSync(resolvedFile)) {
      throw new Error(`Arşiv dosyası bulunamadı: ${relFile}`);
    }

    // Realpath containment check against symlinks escaping server directory
    const realResolvedFile = fs.realpathSync(resolvedFile);
    const relReal = path.relative(realServerDir, realResolvedFile);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error('Erişim reddedildi: Sembolik bağ sunucu dizini dışına çıkıyor.');
    }

    const type = archiveBrowser.getArchiveType(resolvedFile);
    if (!type) {
      throw new Error('Belirtilen dosya desteklenen bir arşiv formatı değil (.zip, .jar, .tar, .tar.gz, .tgz).');
    }

    return archiveBrowser.readEntry(resolvedFile, reqPath, options);
  }

  deleteAllForServer(serverId) {
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('Geçersiz sunucu kimliği (serverId parametresi zorunludur).');
    }

    this._load();

    // 1. Delete all backup files and manifests belonging to serverId
    const toDelete = this.backups.filter((b) => b.serverId === serverId);
    let deletedFilesCount = 0;

    for (const b of toDelete) {
      if (b.filePath && fs.existsSync(b.filePath)) {
        try {
          fs.unlinkSync(b.filePath);
          deletedFilesCount++;
        } catch (err) {
          console.warn(`[BackupManager] Yedek dosyası silinemedi (${b.filePath}):`, err.message);
        }
      }
      const manifestPath = `${b.filePath}.manifest.json`;
      if (fs.existsSync(manifestPath)) {
        try {
          fs.unlinkSync(manifestPath);
        } catch (err) {
          console.warn(`[BackupManager] Manifest dosyası silinemedi (${manifestPath}):`, err.message);
        }
      }
    }

    // Also remove server-specific backup directory under config.BACKUPS_DIR if it exists
    try {
      const serverBackupsDir = path.join(path.resolve(config.BACKUPS_DIR), serverId);
      if (fs.existsSync(serverBackupsDir)) {
        fs.rmSync(serverBackupsDir, { recursive: true, force: true });
      }
    } catch (dirErr) {
      console.warn(`[BackupManager] Sunucu yedek dizini temizlenemedi:`, dirErr.message);
    }

    // 2. Remove all records for serverId from backups.json
    const initialCount = this.backups.length;
    this.backups = this.backups.filter((b) => b.serverId !== serverId);
    const removedRecordsCount = initialCount - this.backups.length;
    this._save();

    // 3. Remove all schedules for serverId (both in-memory daemon and disk backup-schedules.json)
    try {
      const backupScheduler = require('../backups/backupScheduler');
      if (backupScheduler && backupScheduler.schedules && backupScheduler.schedules[serverId]) {
        delete backupScheduler.schedules[serverId];
        if (typeof backupScheduler._save === 'function') {
          backupScheduler._save();
        }
      }
      if (backupScheduler && backupScheduler.locks && backupScheduler.locks.has(serverId)) {
        backupScheduler.locks.delete(serverId);
      }
    } catch (schedErr) {
      const SCHEDULES_FILE = path.join(config.DATA_DIR, 'backup-schedules.json');
      if (fs.existsSync(SCHEDULES_FILE)) {
        try {
          const schedData = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
          if (schedData && schedData[serverId]) {
            delete schedData[serverId];
            const tmp = `${SCHEDULES_FILE}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
            fs.writeFileSync(tmp, JSON.stringify(schedData, null, 2), 'utf8');
            fs.renameSync(tmp, SCHEDULES_FILE);
          }
        } catch (diskErr) {
          console.warn(`[BackupManager] Zamanlama dosyası güncellenemedi:`, diskErr.message);
        }
      }
    }

    return {
      success: true,
      serverId,
      deletedFilesCount,
      removedRecordsCount,
      message: `"${serverId}" kimlikli sunucuya ait tüm yedekler, kayıtlar ve zamanlamalar başarıyla silindi.`
    };
  }
}

const backupManagerInstance = new BackupManager();
backupManagerInstance.sanitizeExclusions = sanitizeExclusions;
backupManagerInstance.matchesExclusion = matchesExclusion;
module.exports = backupManagerInstance;
