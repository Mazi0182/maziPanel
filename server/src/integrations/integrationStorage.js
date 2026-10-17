const fs = require('fs');
const path = require('path');
const config = require('../../config');

const DEFAULT_DISCORD_CONFIG = {
  enabled: false,
  token: '',
  guildId: '',
  voiceChannelId: '',
  status: 'online',
  activityType: 'Playing',
  activityText: 'maziPanel Minecraft'
};

const DEFAULT_USER_INTEGRATION = {
  discordBot: { ...DEFAULT_DISCORD_CONFIG },
  webhooks: []
};

class IntegrationStorage {
  constructor() {
    this._migrated = false;
  }

  getIntegrationsDir() {
    return path.join(config.DATA_DIR, 'integrations');
  }

  ensureDir() {
    const dir = this.getIntegrationsDir();
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error('[IntegrationStorage] Dizin oluşturulamadı:', err.message);
    }
    this._runMigrationIfNeeded();
    return dir;
  }

  _runMigrationIfNeeded() {
    if (this._migrated) return;
    this._migrated = true;

    try {
      const dir = this.getIntegrationsDir();
      const oldDiscordFile = path.join(config.DATA_DIR, 'discord_bot.json');
      const oldWebhooksFile = path.join(config.DATA_DIR, 'webhooks.json');

      const hasOldDiscord = fs.existsSync(oldDiscordFile);
      const hasOldWebhooks = fs.existsSync(oldWebhooksFile);

      if (!hasOldDiscord && !hasOldWebhooks) {
        return;
      }

      // Determine admin username for legacy ownership assignment
      let adminUsername = 'mazidev';
      try {
        const authService = require('../auth/authService');
        if (authService && typeof authService.getFirstAdminUsername === 'function') {
          adminUsername = authService.getFirstAdminUsername() || 'mazidev';
        }
      } catch (e) {
        // Fallback default
      }
      adminUsername = String(adminUsername || 'mazidev').trim().toLowerCase();

      const adminFilePath = path.join(dir, `${adminUsername}.json`);
      let migratedDiscord = { ...DEFAULT_DISCORD_CONFIG };
      let migratedWebhooks = [];

      // Read old discord_bot.json
      if (hasOldDiscord) {
        try {
          const raw = fs.readFileSync(oldDiscordFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            migratedDiscord = { ...DEFAULT_DISCORD_CONFIG, ...parsed };
          }
        } catch (err) {
          console.warn('[IntegrationStorage] Eski discord_bot.json okunamadı:', err.message);
        }
      }

      // Read old webhooks.json
      if (hasOldWebhooks) {
        try {
          const raw = fs.readFileSync(oldWebhooksFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            migratedWebhooks = parsed;
          }
        } catch (err) {
          console.warn('[IntegrationStorage] Eski webhooks.json okunamadı:', err.message);
        }
      }

      // Save into admin user integrations if not already existing
      if (!fs.existsSync(adminFilePath)) {
        const initialAdminData = {
          discordBot: migratedDiscord,
          webhooks: migratedWebhooks
        };
        const tempAdminPath = `${adminFilePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempAdminPath, JSON.stringify(initialAdminData, null, 2), 'utf8');
        fs.renameSync(tempAdminPath, adminFilePath);
        console.log(`[IntegrationStorage] Mevcut global entegrasyonlar '${adminUsername}' kullanıcısına başarıyla aktarıldı.`);
      }

      // Preserve backups (.bak) and remove old unmigrated files
      if (hasOldDiscord) {
        try {
          const bakFile = `${oldDiscordFile}.bak`;
          fs.copyFileSync(oldDiscordFile, bakFile);
          fs.unlinkSync(oldDiscordFile);
        } catch (e) {}
      }

      if (hasOldWebhooks) {
        try {
          const bakFile = `${oldWebhooksFile}.bak`;
          fs.copyFileSync(oldWebhooksFile, bakFile);
          fs.unlinkSync(oldWebhooksFile);
        } catch (e) {}
      }
    } catch (err) {
      console.error('[IntegrationStorage] Otomatik taşıma (migration) sırasında hata oluştu:', err.message);
    }
  }

  normalizeUsername(username) {
    if (!username || typeof username !== 'string') {
      try {
        const authService = require('../auth/authService');
        const admin = authService.getFirstAdminUsername();
        return String(admin || 'mazidev').trim().toLowerCase();
      } catch (e) {
        return 'mazidev';
      }
    }
    return username.trim().toLowerCase();
  }

  getUserFilePath(username) {
    const dir = this.ensureDir();
    const cleanUsername = this.normalizeUsername(username);
    // Sanitize filename to prevent directory traversal
    const safeName = cleanUsername.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return path.join(dir, `${safeName}.json`);
  }

  getUserData(username) {
    const filePath = this.getUserFilePath(username);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          discordBot: { ...DEFAULT_DISCORD_CONFIG, ...(parsed.discordBot || {}) },
          webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : []
        };
      }
    } catch (err) {
      console.warn(`[IntegrationStorage] Kullanıcı verisi okunamadı (${username}):`, err.message);
    }

    return {
      discordBot: { ...DEFAULT_DISCORD_CONFIG },
      webhooks: []
    };
  }

  saveUserData(username, data) {
    const filePath = this.getUserFilePath(username);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      const current = this.getUserData(username);
      const toSave = {
        discordBot: { ...current.discordBot, ...(data.discordBot || {}) },
        webhooks: Array.isArray(data.webhooks) ? data.webhooks : current.webhooks
      };
      fs.writeFileSync(tempPath, JSON.stringify(toSave, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (e) {}
      console.error(`[IntegrationStorage] Kullanıcı verisi yazılamadı (${username}):`, err.message);
      return false;
    }
  }

  deleteUserData(username) {
    const filePath = this.getUserFilePath(username);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch (err) {
      console.error(`[IntegrationStorage] Kullanıcı verisi silinemedi (${username}):`, err.message);
      return false;
    }
    return false;
  }

  listAllIntegrationUsers() {
    const dir = this.ensureDir();
    try {
      if (!fs.existsSync(dir)) return [];
      const files = fs.readdirSync(dir);
      return files
        .filter((f) => f.endsWith('.json') && !f.endsWith('.bak'))
        .map((f) => path.basename(f, '.json'));
    } catch (err) {
      return [];
    }
  }
}

const integrationStorage = new IntegrationStorage();
module.exports = {
  integrationStorage,
  DEFAULT_DISCORD_CONFIG,
  DEFAULT_USER_INTEGRATION
};
