const express = require('express');
const router = express.Router();
const fs = require('fs');
const backupManager = require('./backupManager');
const backupScheduler = require('../backups/backupScheduler');
const serverRegistry = require('./serverRegistry');
const authMiddleware = require('../auth/authMiddleware');

// Auto-initialize backup scheduler daemon when backupsController is loaded
backupScheduler.init(backupManager);

router.use(authMiddleware);

function verifyServerOwnership(req, res, serverId) {
  const server = serverRegistry.getById(serverId);
  if (!server) {
    res.status(404).json({ error: 'Sunucu bulunamadı.' });
    return null;
  }
  if (req.user && req.user.role === 'admin') {
    return server;
  }
  const reqUsername = req.user && req.user.username ? req.user.username.trim().toLowerCase() : null;
  if (!reqUsername || (server.owner || '').toLowerCase() !== reqUsername) {
    res.status(403).json({ error: 'Bu sunucuya erişim yetkiniz yok.' });
    return null;
  }
  return server;
}

function verifyBackupOwnership(req, res, backupId) {
  const backup = backupManager.getBackupById(backupId);
  if (!backup) {
    res.status(404).json({ error: 'Yedek bulunamadı.' });
    return null;
  }
  const server = serverRegistry.getById(backup.serverId);
  if (!server) {
    res.status(404).json({ error: 'İlişkili sunucu bulunamadı.' });
    return null;
  }
  if (req.user && req.user.role === 'admin') {
    return { backup, server };
  }
  const reqUsername = req.user && req.user.username ? req.user.username.trim().toLowerCase() : null;
  if (!reqUsername || (server.owner || '').toLowerCase() !== reqUsername) {
    res.status(403).json({ error: 'Bu yedeğe erişim yetkiniz yok.' });
    return null;
  }
  return { backup, server };
}

// Validate server ownership for :serverId params
router.param('serverId', (req, res, next, serverId) => {
  const server = verifyServerOwnership(req, res, serverId);
  if (!server) return;
  req.server = server;
  next();
});

// Validate server ownership for :backupId params
router.param('backupId', (req, res, next, backupId) => {
  const verified = verifyBackupOwnership(req, res, backupId);
  if (!verified) return;
  req.backup = verified.backup;
  req.server = verified.server;
  next();
});

// ==========================================
// 1. SCHEDULES ROUTES (Defined before :backupId)
// ==========================================

// GET /api/backups/schedules - List backup schedules for accessible servers
router.get('/schedules', (req, res) => {
  try {
    const ownerFilter = req.user && req.user.role === 'admin'
      ? null
      : (req.user && req.user.username ? req.user.username.trim().toLowerCase() : null);
    const servers = serverRegistry.getAll(ownerFilter);
    const result = {};
    for (const s of servers) {
      result[s.id] = backupScheduler.getSchedule(s.id);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backups/schedules/:serverId - Get backup schedule for server
router.get('/schedules/:serverId', (req, res) => {
  try {
    const { serverId } = req.params;
    const schedule = backupScheduler.getSchedule(serverId);
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/backups/schedules/:serverId - Update backup schedule for server
router.put('/schedules/:serverId', (req, res) => {
  try {
    const { serverId } = req.params;
    const updated = backupScheduler.setSchedule(serverId, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 2. SERVER ARCHIVE BROWSING ROUTES (Defined before :backupId)
// ==========================================

// GET /api/backups/archive/entries - Browse directory inside server archive
router.get('/archive/entries', (req, res) => {
  try {
    const { serverId, file, path: reqPath } = req.query;
    if (!serverId || !file) {
      return res.status(400).json({ error: 'serverId ve file parametreleri zorunludur.' });
    }
    if (!verifyServerOwnership(req, res, serverId)) return;
    const result = backupManager.getServerArchiveEntries(serverId, file, reqPath || '');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/backups/archive/entry - View or download single entry from server archive
router.get('/archive/entry', async (req, res) => {
  try {
    const { serverId, file, path: reqPath, download } = req.query;
    if (!serverId || !file || !reqPath) {
      return res.status(400).json({ error: 'serverId, file ve path parametreleri zorunludur.' });
    }
    if (!verifyServerOwnership(req, res, serverId)) return;
    const result = await backupManager.getServerArchiveEntry(serverId, file, reqPath, { download });
    if (download === '1' || download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      result.stream.pipe(res);
    } else {
      res.json(result);
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 3. BACKUP LIST & CREATE
// ==========================================

// GET /api/backups - List all backups
router.get('/', (req, res) => {
  try {
    const serverId = req.query.serverId || null;
    if (serverId) {
      if (!verifyServerOwnership(req, res, serverId)) return;
    }
    const ownerFilter = req.user && req.user.role === 'admin'
      ? null
      : (req.user && req.user.username ? req.user.username.trim().toLowerCase() : null);
    const backups = backupManager.listBackups(serverId, ownerFilter);
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups - Create new backup
router.post('/', async (req, res) => {
  try {
    const { serverId, name, format, level, compression, exclusions, destDir, singleFile, targetBackupId, targetFilename } = req.body;
    if (!serverId) {
      return res.status(400).json({ error: 'serverId zorunludur.' });
    }
    if (!verifyServerOwnership(req, res, serverId)) return;
    const safeExclusions = backupManager.sanitizeExclusions(exclusions);
    const backup = await backupManager.createBackup(serverId, {
      name,
      format,
      level,
      compression,
      exclusions: safeExclusions,
      destDir,
      singleFile: Boolean(singleFile),
      targetBackupId: targetBackupId || undefined,
      targetFilename: targetFilename || undefined,
      source: 'manual'
    });
    res.status(201).json(backup);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// ==========================================
// 4. BACKUP SPECIFIC ARCHIVE BROWSING ROUTES
// ==========================================

// GET /api/backups/:backupId/entries - Browse directory inside backup
router.get('/:backupId/entries', (req, res) => {
  try {
    const { backupId } = req.params;
    const reqPath = req.query.path || '';
    const result = backupManager.getBackupEntries(backupId, reqPath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/backups/:backupId/entry - View or download single entry from backup
router.get('/:backupId/entry', async (req, res) => {
  try {
    const { backupId } = req.params;
    const reqPath = req.query.path;
    if (!reqPath) {
      return res.status(400).json({ error: 'path parametresi zorunludur.' });
    }
    const download = req.query.download;
    const result = await backupManager.getBackupEntry(backupId, reqPath, { download });
    if (download === '1' || download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      result.stream.pipe(res);
    } else {
      res.json(result);
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 5. BACKUP OPERATIONS (:backupId)
// ==========================================

// GET /api/backups/:backupId - Get single backup details
router.get('/:backupId', (req, res) => {
  try {
    const backup = backupManager.getBackupById(req.params.backupId);
    if (!backup) {
      return res.status(404).json({ error: 'Yedek bulunamadı.' });
    }
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backups/:backupId/restore - Restore backup
router.post('/:backupId/restore', async (req, res) => {
  try {
    const backup = backupManager.getBackupById(req.params.backupId);
    if (!backup) {
      return res.status(404).json({ error: 'Yedek bulunamadı.' });
    }
    const forceStop = req.body.forceStop === true || req.query.forceStop === 'true';
    const result = await backupManager.restoreBackup(backup.serverId, backup.id, { forceStop });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// DELETE /api/backups/:backupId - Delete backup
router.delete('/:backupId', (req, res) => {
  try {
    const result = backupManager.deleteBackup(req.params.backupId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /api/backups/:backupId/download - Download backup file
router.get('/:backupId/download', (req, res) => {
  try {
    const backup = backupManager.getBackupById(req.params.backupId);
    if (!backup) {
      return res.status(404).json({ error: 'Yedek bulunamadı.' });
    }
    if (!fs.existsSync(backup.filePath)) {
      return res.status(404).json({ error: 'Yedek dosyası diskte bulunamadı.' });
    }
    res.download(backup.filePath, backup.filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
