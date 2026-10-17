const fs = require('fs');
const path = require('path');
const config = require('../../config');
const incrementalEngine = require('./incremental');
const processManager = require('../servers/processManager');

const SCHEDULES_FILE = path.join(config.DATA_DIR, 'backup-schedules.json');

function parseTimeHHMM(timeStr, fallbackHour = 4, fallbackMin = 0) {
  if (!timeStr || typeof timeStr !== 'string') {
    return { hour: fallbackHour, minute: fallbackMin };
  }
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return { hour: fallbackHour, minute: fallbackMin };
  }
  const hour = Math.max(0, Math.min(23, parseInt(match[1], 10)));
  const minute = Math.max(0, Math.min(59, parseInt(match[2], 10)));
  return { hour, minute };
}

function getIstanbulDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const day = parseInt(map.day, 10);
  const month = parseInt(map.month, 10) - 1; // 0-indexed
  const year = parseInt(map.year, 10);
  const hour = parseInt(map.hour, 10);
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);

  // Determine weekday in Istanbul
  const dayOfWeek = new Date(Date.UTC(year, month, day, 12, 0, 0)).getUTCDay();

  return { year, month, day, hour, minute, second, dayOfWeek };
}

function istanbulToUtcDate(year, month, day, hour, minute, second = 0) {
  // Istanbul is UTC+3 permanently
  return new Date(Date.UTC(year, month, day, hour - 3, minute, second));
}

class BackupScheduler {
  constructor() {
    this.schedules = {};
    this.timer = null;
    this.locks = new Set();
    this.activeServerLocks = processManager.activeServerLocks;
    this.backupManager = null;
    this.initialized = false;
  }

  setBackupManager(bm) {
    this.backupManager = bm;
  }

  _load() {
    if (!fs.existsSync(SCHEDULES_FILE)) {
      this.schedules = {};
      this._save();
      return;
    }
    try {
      const data = fs.readFileSync(SCHEDULES_FILE, 'utf8');
      this.schedules = JSON.parse(data);
    } catch (err) {
      console.error('[BackupScheduler] Zamanlama dosyası okunamadı, sıfırlanıyor:', err.message);
      this.schedules = {};
    }
  }

  _save() {
    try {
      const tmp = `${SCHEDULES_FILE}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmp, JSON.stringify(this.schedules, null, 2), 'utf8');
      fs.renameSync(tmp, SCHEDULES_FILE);
    } catch (err) {
      console.error('[BackupScheduler] Zamanlama dosyası yazılamadı:', err.message);
    }
  }

  getDefaultSchedule(serverId) {
    return {
      enabled: false,
      frequency: 'daily',
      intervalHours: 6,
      intervalWindow: null,
      dailyTime: '04:00',
      weeklyDays: [0], // Sunday
      weeklyTime: '04:00',
      name: '',
      format: 'zip',
      level: 6,
      exclusions: ['logs', 'crash-reports'],
      maxBackups: null,
      singleFile: false,
      targetBackupId: '',
      runImmediately: true,
      nextRunAt: null,
      lastRunAt: null,
      lastResult: null
    };
  }

  getSchedule(serverId) {
    this._load();
    const existing = this.schedules[serverId];
    if (!existing) {
      return this.getDefaultSchedule(serverId);
    }
    return {
      ...this.getDefaultSchedule(serverId),
      ...existing
    };
  }

  setSchedule(serverId, input) {
    this._load();
    const current = this.getSchedule(serverId);

    const frequency = ['interval', 'daily', 'weekly'].includes(input.frequency) ? input.frequency : current.frequency;
    const intervalHours = Math.max(1, Math.min(24, parseInt(input.intervalHours, 10) || current.intervalHours));

    let intervalWindow = null;
    if (input.intervalWindow && typeof input.intervalWindow === 'object') {
      const from = input.intervalWindow.from;
      const to = input.intervalWindow.to;
      if (from && to && typeof from === 'string' && typeof to === 'string') {
        intervalWindow = { from: from.trim(), to: to.trim() };
      }
    }

    const dailyTime = typeof input.dailyTime === 'string' ? input.dailyTime.trim() : current.dailyTime;
    const weeklyDays = Array.isArray(input.weeklyDays) ? input.weeklyDays.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6) : current.weeklyDays;
    const weeklyTime = typeof input.weeklyTime === 'string' ? input.weeklyTime.trim() : current.weeklyTime;

    let format = ['zip', 'tar.gz', 'tar'].includes(input.format) ? input.format : current.format;
    const singleFile = Boolean(input.singleFile);
    if (singleFile) {
      format = 'zip'; // Force zip for single-file mode
    }

    const level = Math.max(0, Math.min(9, parseInt(input.level, 10) !== undefined && !isNaN(parseInt(input.level, 10)) ? parseInt(input.level, 10) : current.level));
    const exclusions = incrementalEngine.sanitizeExclusions(
      input.exclusions !== undefined ? input.exclusions : current.exclusions
    );
    const maxBackups = input.maxBackups !== null && input.maxBackups !== undefined && !isNaN(parseInt(input.maxBackups, 10)) ? parseInt(input.maxBackups, 10) : null;
    const enabled = Boolean(input.enabled);
    const name = typeof input.name === 'string' ? input.name : current.name;
    const targetBackupId = typeof input.targetBackupId === 'string' ? input.targetBackupId.trim() : (current.targetBackupId || '');
    const runImmediately = input.runImmediately !== undefined ? Boolean(input.runImmediately) : (current.runImmediately !== false);

    const schedule = {
      ...current,
      enabled,
      frequency,
      intervalHours,
      intervalWindow,
      dailyTime,
      weeklyDays,
      weeklyTime,
      name,
      format,
      level,
      exclusions,
      maxBackups,
      singleFile,
      targetBackupId,
      runImmediately
    };

    if (enabled) {
      schedule.nextRunAt = this.calculateNextRun(schedule, new Date());
    } else {
      schedule.nextRunAt = null;
    }

    this.schedules[serverId] = schedule;
    this._save();

    if (enabled && (runImmediately || input.triggerNow === true)) {
      setImmediate(() => {
        this._executeScheduledBackup(serverId, schedule).catch((err) => {
          console.error(`[BackupScheduler] "${serverId}" başlangıç yedeklemesi hatası:`, err.message);
        });
      });
    }

    return schedule;
  }

  calculateNextRun(schedule, referenceDate = new Date()) {
    if (!schedule.enabled) return null;

    const istanbulNow = getIstanbulDateParts(referenceDate);

    if (schedule.frequency === 'daily') {
      const { hour: targetH, minute: targetM } = parseTimeHHMM(schedule.dailyTime, 4, 0);
      let targetUtc = istanbulToUtcDate(istanbulNow.year, istanbulNow.month, istanbulNow.day, targetH, targetM, 0);

      // If target time has already passed today, schedule for tomorrow
      if (targetUtc.getTime() <= referenceDate.getTime()) {
        targetUtc = new Date(targetUtc.getTime() + 24 * 3600 * 1000);
      }
      return targetUtc.toISOString();
    }

    if (schedule.frequency === 'weekly') {
      const days = schedule.weeklyDays && schedule.weeklyDays.length > 0 ? schedule.weeklyDays : [0];
      const { hour: targetH, minute: targetM } = parseTimeHHMM(schedule.weeklyTime, 4, 0);

      // Check next 7 days for matching weekday
      for (let offset = 0; offset <= 7; offset++) {
        const checkRef = new Date(referenceDate.getTime() + offset * 24 * 3600 * 1000);
        const checkParts = getIstanbulDateParts(checkRef);
        if (days.includes(checkParts.dayOfWeek)) {
          const candidateUtc = istanbulToUtcDate(checkParts.year, checkParts.month, checkParts.day, targetH, targetM, 0);
          if (candidateUtc.getTime() > referenceDate.getTime()) {
            return candidateUtc.toISOString();
          }
        }
      }

      // Fallback
      return new Date(referenceDate.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    }

    if (schedule.frequency === 'interval') {
      const hours = schedule.intervalHours || 6;
      let nextMs = referenceDate.getTime() + hours * 3600 * 1000;

      // Check intervalWindow if defined
      if (schedule.intervalWindow && schedule.intervalWindow.from && schedule.intervalWindow.to) {
        const fromTime = parseTimeHHMM(schedule.intervalWindow.from, 0, 0);
        const toTime = parseTimeHHMM(schedule.intervalWindow.to, 23, 59);

        let candidateDate = new Date(nextMs);
        let candParts = getIstanbulDateParts(candidateDate);
        const candTotalMin = candParts.hour * 60 + candParts.minute;
        const fromTotalMin = fromTime.hour * 60 + fromTime.minute;
        const toTotalMin = toTime.hour * 60 + toTime.minute;

        if (candTotalMin < fromTotalMin) {
          // Push to 'from' time today
          candidateDate = istanbulToUtcDate(candParts.year, candParts.month, candParts.day, fromTime.hour, fromTime.minute, 0);
          nextMs = candidateDate.getTime();
        } else if (candTotalMin > toTotalMin) {
          // Push to 'from' time tomorrow
          candidateDate = istanbulToUtcDate(candParts.year, candParts.month, candParts.day + 1, fromTime.hour, fromTime.minute, 0);
          nextMs = candidateDate.getTime();
        }
      }

      return new Date(nextMs).toISOString();
    }

    return null;
  }

  init(backupManagerInstance) {
    if (this.initialized) return;
    this.initialized = true;

    if (backupManagerInstance) {
      this.backupManager = backupManagerInstance;
    }

    this._load();
    console.log('[BackupScheduler] Yedekleme zamanlayıcı servisi başlatılıyor...');

    // Catch-up check on boot
    this._runCatchUpCheck();

    // Run scheduler check every 60 seconds
    this.timer = setInterval(() => {
      this._checkSchedules();
    }, 60 * 1000);
  }

  async _runCatchUpCheck() {
    this._load();
    const now = new Date();

    for (const [serverId, schedule] of Object.entries(this.schedules)) {
      if (!schedule.enabled) continue;

      let shouldCatchUp = false;
      if (schedule.nextRunAt) {
        const nextTime = new Date(schedule.nextRunAt).getTime();
        if (nextTime <= now.getTime()) {
          shouldCatchUp = true;
        }
      }

      if (shouldCatchUp) {
        console.log(`[BackupScheduler] "${serverId}" sunucusu için kaçırılan zamanlanmış yedekleme yürütülüyor...`);
        await this._executeScheduledBackup(serverId, schedule);
      } else if (!schedule.nextRunAt) {
        schedule.nextRunAt = this.calculateNextRun(schedule, now);
        this._save();
      }
    }
  }

  async _checkSchedules() {
    this._load();
    const now = new Date();

    for (const [serverId, schedule] of Object.entries(this.schedules)) {
      if (!schedule.enabled) continue;

      if (!schedule.nextRunAt) {
        schedule.nextRunAt = this.calculateNextRun(schedule, now);
        this._save();
        continue;
      }

      const nextTime = new Date(schedule.nextRunAt).getTime();
      if (now.getTime() >= nextTime) {
        await this._executeScheduledBackup(serverId, schedule);
      }
    }
  }

  async _executeScheduledBackup(serverId, schedule) {
    // Concurrency lock: do not run multiple backups or conflict with active server lifecycle operations
    if (this.locks.has(serverId) || processManager.isServerLocked(serverId)) {
      console.warn(`[BackupScheduler] "${serverId}" sunucusu üzerinde devam eden bir işlem var, zamanlanmış yedekleme atlandı.`);
      return;
    }

    this.locks.add(serverId);
    const now = new Date();

    try {
      console.log(`[BackupScheduler] "${serverId}" sunucusu için zamanlanmış yedekleme başlatılıyor...`);

      if (!this.backupManager) {
        this.backupManager = require('../servers/backupManager');
      }

      const backupResult = await this.backupManager.createBackup(serverId, {
        name: schedule.name || undefined,
        format: schedule.format || 'zip',
        level: schedule.level !== undefined ? schedule.level : 6,
        exclusions: schedule.exclusions || ['logs', 'crash-reports'],
        singleFile: Boolean(schedule.singleFile),
        targetBackupId: schedule.singleFile && schedule.targetBackupId ? schedule.targetBackupId : undefined,
        source: 'scheduled'
      });

      if (schedule.singleFile && backupResult && backupResult.id) {
        schedule.targetBackupId = backupResult.id;
      }

      // Manage maxBackups rotation if specified
      if (schedule.maxBackups !== null && schedule.maxBackups > 0 && !schedule.singleFile) {
        try {
          const allBackups = this.backupManager.listBackups(serverId);
          // Only prune scheduled backups! Keep manual backups untouched.
          const scheduledBackups = allBackups.filter((b) => b.source === 'scheduled');
          if (scheduledBackups.length > schedule.maxBackups) {
            // Sort by createdAt ascending (oldest first)
            scheduledBackups.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            const toDeleteCount = scheduledBackups.length - schedule.maxBackups;
            const toDelete = scheduledBackups.slice(0, toDeleteCount);

            for (const oldBackup of toDelete) {
              console.log(`[BackupScheduler] Eski zamanlanmış yedek temizleniyor: ${oldBackup.id} (${oldBackup.filename})`);
              this.backupManager.deleteBackup(oldBackup.id, serverId);
            }
          }
        } catch (rotErr) {
          console.warn(`[BackupScheduler] "${serverId}" için yedek rotasyonu kontrolü başarısız oldu:`, rotErr.message);
        }
      }

      schedule.lastRunAt = now.toISOString();
      schedule.lastResult = {
        success: true,
        message: 'Zamanlanmış yedekleme başarıyla tamamlandı.',
        stats: backupResult.stats || undefined
      };
      schedule.nextRunAt = this.calculateNextRun(schedule, now);
      this.schedules[serverId] = schedule;
      this._save();

      console.log(`[BackupScheduler] "${serverId}" sunucusu için zamanlanmış yedekleme tamamlandı.`);
    } catch (err) {
      console.error(`[BackupScheduler] "${serverId}" sunucusu için zamanlanmış yedekleme başarısız oldu:`, err.message);
      schedule.lastRunAt = now.toISOString();
      schedule.lastResult = {
        success: false,
        message: `Yedekleme hatası: ${err.message}`
      };
      schedule.nextRunAt = this.calculateNextRun(schedule, now);
      this.schedules[serverId] = schedule;
      this._save();
    } finally {
      this.locks.delete(serverId);
    }
  }
}

module.exports = new BackupScheduler();
