const { integrationStorage, DEFAULT_DISCORD_CONFIG } = require('./integrationStorage');
let serverRegistry = null;

function getServerRegistry() {
  if (!serverRegistry) {
    try {
      serverRegistry = require('../servers/serverRegistry');
    } catch (e) {}
  }
  return serverRegistry;
}

// Dynamic require with graceful fallback
let Discord = null;
let Voice = null;
let discordPackageAvailable = false;
let voicePackageAvailable = false;
let packageError = null;

try {
  try {
    Discord = require('discord.js');
  } catch (e1) {
    Discord = require('/mazideveloper/server/node_modules_dc/discord.js');
  }
  discordPackageAvailable = true;
} catch (err) {
  packageError = 'discord.js paketi bu sistemde kurulu değil.';
}

try {
  try {
    Voice = require('@discordjs/voice');
  } catch (e1) {
    Voice = require('/mazideveloper/server/node_modules_dc/@discordjs/voice');
  }
  voicePackageAvailable = true;
} catch (err) {
  // Voice package optional
}

class DiscordBotService {
  constructor() {
    // Map<username, Discord.Client>
    this.clients = new Map();
    // Map<username, VoiceConnection>
    this.voiceConnections = new Map();
    // Map<username, { isConnecting: boolean, lastError: string|null }>
    this.botStates = new Map();
    this.initTimeout = null;

    // Auto-connect configured bots on startup
    if (discordPackageAvailable) {
      this.initTimeout = setTimeout(() => {
        this.initAllActiveBots().catch((err) => {
          console.warn('[DiscordBotService] Başlangıç bot bağlantıları kurulurken uyarı:', err.message);
        });
      }, 500);
      if (this.initTimeout && typeof this.initTimeout.unref === 'function') {
        this.initTimeout.unref();
      }
    }
  }

  /**
   * Initializes bots for all users with enabled configs.
   */
  async initAllActiveBots() {
    if (!discordPackageAvailable) return;
    const users = integrationStorage.listAllIntegrationUsers();
    for (const username of users) {
      const cfg = this.getConfig(username);
      if (cfg.enabled && cfg.token) {
        this.start(username).catch((err) => {
          console.warn(`[DiscordBotService] '${username}' botu başlangıçta bağlanamadı:`, err.message);
        });
      }
    }
  }

  _getState(username) {
    const user = integrationStorage.normalizeUsername(username);
    if (!this.botStates.has(user)) {
      this.botStates.set(user, { isConnecting: false, lastError: packageError });
    }
    return this.botStates.get(user);
  }

  /**
   * Get internal bot configuration for user (contains token for service use).
   */
  getConfig(username = null) {
    const user = integrationStorage.normalizeUsername(username);
    const data = integrationStorage.getUserData(user);
    return { ...DEFAULT_DISCORD_CONFIG, ...(data.discordBot || {}) };
  }

  /**
   * Get public sanitized bot configuration for API responses.
   * Real token is NEVER included.
   */
  getPublicConfig(username = null) {
    const cfg = this.getConfig(username);
    const hasToken = Boolean(cfg.token && cfg.token.trim());
    const tokenMasked = hasToken
      ? (cfg.token.trim().length > 4 ? `••••••••${cfg.token.trim().slice(-4)}` : '••••••••')
      : '';

    return {
      enabled: Boolean(cfg.enabled),
      hasToken,
      tokenMasked,
      guildId: cfg.guildId || '',
      voiceChannelId: cfg.voiceChannelId || '',
      status: cfg.status || 'online',
      activityType: cfg.activityType || 'Playing',
      activityText: cfg.activityText || ''
    };
  }

  /**
   * Update bot configuration for user.
   * Write-only token policy: if token is omitted or empty, existing token is preserved.
   */
  async updateConfig(username = null, newConfig = {}) {
    const user = integrationStorage.normalizeUsername(username);
    const current = this.getConfig(user);

    if (newConfig.enabled !== undefined) {
      current.enabled = Boolean(newConfig.enabled);
    }

    // Write-only token check: only update if non-empty string provided
    if (newConfig.token !== undefined && newConfig.token !== null && typeof newConfig.token === 'string') {
      const trimmedToken = newConfig.token.trim();
      if (trimmedToken.length > 0) {
        current.token = trimmedToken;
      }
    }

    if (newConfig.guildId !== undefined) {
      current.guildId = String(newConfig.guildId).trim();
    }
    if (newConfig.voiceChannelId !== undefined) {
      current.voiceChannelId = String(newConfig.voiceChannelId).trim();
    }
    if (newConfig.status !== undefined) {
      const validStatuses = ['online', 'idle', 'dnd'];
      current.status = validStatuses.includes(newConfig.status) ? newConfig.status : 'online';
    }
    if (newConfig.activityType !== undefined) {
      const validTypes = ['Playing', 'Listening', 'Watching', 'Streaming'];
      current.activityType = validTypes.includes(newConfig.activityType) ? newConfig.activityType : 'Playing';
    }
    if (newConfig.activityText !== undefined) {
      current.activityText = String(newConfig.activityText);
    }

    integrationStorage.saveUserData(user, { discordBot: current });

    // Apply runtime changes
    if (discordPackageAvailable) {
      if (current.enabled && current.token) {
        const client = this.clients.get(user);
        if (!client || !client.isReady || !client.isReady()) {
          this.start(user).catch((err) => {
            console.error(`[DiscordBotService] '${user}' bot başlatma hatası:`, err.message);
          });
        } else {
          this.updatePresence(user);
        }
      } else {
        if (this.clients.has(user)) {
          this.stop(user);
        }
      }
    }

    return this.getPublicConfig(user);
  }

  /**
   * Start discord bot connection for specific user.
   */
  async start(username = null) {
    const user = integrationStorage.normalizeUsername(username);
    const state = this._getState(user);

    if (!discordPackageAvailable) {
      state.lastError = 'discord.js paketi bu sistemde kurulu değil.';
      return false;
    }

    const cfg = this.getConfig(user);
    if (!cfg.token) {
      state.lastError = 'Bot tokeni eksik veya belirtilmemiş.';
      return false;
    }

    if (state.isConnecting) return false;
    state.isConnecting = true;
    state.lastError = null;

    try {
      const existingClient = this.clients.get(user);
      if (existingClient) {
        try {
          existingClient.destroy();
        } catch (e) {}
        this.clients.delete(user);
      }

      const intents = [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildVoiceStates
      ];

      const client = new Discord.Client({ intents });
      this.clients.set(user, client);

      client.once('ready', async () => {
        state.isConnecting = false;
        state.lastError = null;
        console.log(`[DiscordBotService] '${user}' botu başarıyla bağlandı: ${client.user.tag}`);
        const anyOnline = this.isAnyUserServerOnline(user);
        this.updatePresence(user, anyOnline);
        if (anyOnline && cfg.guildId && cfg.voiceChannelId) {
          this.joinVoice(user).catch((err) => {
            console.warn(`[DiscordBotService] '${user}' otomatik ses kanalı bağlantısı uyarısı:`, err.message);
          });
        }
      });

      client.on('error', (err) => {
        console.error(`[DiscordBotService] '${user}' bot çalışma zamanı hatası:`, err.message);
        state.lastError = err.message;
      });

      await client.login(cfg.token);
      return true;
    } catch (err) {
      state.isConnecting = false;
      state.lastError = err.message;
      console.error(`[DiscordBotService] '${user}' bot giriş hatası:`, err.message);
      return false;
    }
  }

  /**
   * Stop bot and voice connection for a specific user.
   */
  stop(username = null) {
    const user = integrationStorage.normalizeUsername(username);
    this.leaveVoice(user);

    const client = this.clients.get(user);
    if (client) {
      try {
        client.destroy();
      } catch (e) {}
      this.clients.delete(user);
    }

    const state = this._getState(user);
    state.isConnecting = false;
  }

  /**
   * Get runtime connection status and diagnostics for a user.
   * Never includes raw token.
   */
  getStatus(username = null) {
    const user = integrationStorage.normalizeUsername(username);
    const cfg = this.getConfig(user);
    const state = this._getState(user);
    const client = this.clients.get(user);
    const voiceConn = this.voiceConnections.get(user);

    const hasToken = Boolean(cfg.token && cfg.token.trim());
    const isReady = Boolean(client && typeof client.isReady === 'function' && client.isReady());

    let connectionState = 'offline';
    if (!discordPackageAvailable) {
      connectionState = 'package_missing';
    } else if (!cfg.enabled) {
      connectionState = 'disabled';
    } else if (state.isConnecting) {
      connectionState = 'connecting';
    } else if (isReady) {
      connectionState = cfg.status || 'online';
    } else if (state.lastError) {
      connectionState = 'error';
    }

    return {
      enabled: Boolean(cfg.enabled),
      configured: hasToken,
      hasToken,
      available: discordPackageAvailable,
      voiceAvailable: voicePackageAvailable,
      connected: isReady,
      status: connectionState,
      user: isReady && client?.user ? {
        id: client.user.id,
        tag: client.user.tag || `${client.user.username}#${client.user.discriminator || '0000'}`,
        username: client.user.username,
        avatar: typeof client.user.avatarURL === 'function' ? client.user.avatarURL() : null
      } : null,
      voiceConnected: Boolean(voiceConn),
      guildId: cfg.guildId || null,
      voiceChannelId: cfg.voiceChannelId || null,
      activity: {
        type: cfg.activityType || 'Playing',
        text: cfg.activityText || ''
      },
      lastError: state.lastError
    };
  }

  /**
   * Test connection using user's saved token or an explicit token.
   */
  async testConnection(username = null, tokenOverride = null) {
    if (!discordPackageAvailable) {
      return {
        success: false,
        error: 'discord.js paketi bu sistemde kurulu değil. Entegrasyon için discord.js gereklidir.'
      };
    }

    const user = integrationStorage.normalizeUsername(username);
    const cfg = this.getConfig(user);
    const token = (tokenOverride && String(tokenOverride).trim()) || (cfg.token && cfg.token.trim());

    if (!token) {
      return {
        success: false,
        error: 'Bot tokeni eksik veya boş.'
      };
    }

    // Fast REST API check
    if (Discord.REST && Discord.Routes) {
      try {
        const rest = new Discord.REST({ version: '10' }).setToken(token);
        const discordUser = await rest.get(Discord.Routes.user('@me'));
        return {
          success: true,
          user: {
            id: discordUser.id,
            username: discordUser.username,
            tag: `${discordUser.username}#${discordUser.discriminator || '0000'}`
          }
        };
      } catch (restErr) {
        return {
          success: false,
          error: restErr.message || 'Discord REST kimlik doğrulaması başarısız oldu.'
        };
      }
    }

    // Temporary Client login fallback
    return new Promise((resolve) => {
      const tempClient = new Discord.Client({ intents: [Discord.GatewayIntentBits.Guilds] });
      const timer = setTimeout(() => {
        try {
          tempClient.destroy();
        } catch (e) {}
        resolve({
          success: false,
          error: 'Bağlantı testi 8 saniye sonra zaman aşımına uğradı.'
        });
      }, 8000);

      tempClient.once('ready', () => {
        clearTimeout(timer);
        const userInfo = {
          id: tempClient.user.id,
          username: tempClient.user.username,
          tag: tempClient.user.tag
        };
        try {
          tempClient.destroy();
        } catch (e) {}
        resolve({
          success: true,
          user: userInfo
        });
      });

      tempClient.login(token).catch((err) => {
        clearTimeout(timer);
        try {
          tempClient.destroy();
        } catch (e) {}
        resolve({
          success: false,
          error: err.message
        });
      });
    });
  }

  /**
   * Join configured voice channel.
   * If username is provided, joins for that user.
   * If username is omitted, iterates through all active bots.
   */
  async joinVoice(usernameOrChannel = null, maybeOwner = null) {
    if (!voicePackageAvailable) {
      return {
        success: false,
        error: '@discordjs/voice paketi bu sistemde kurulu değil. Ses özellikleri için @discordjs/voice gereklidir.'
      };
    }

    const username = (usernameOrChannel === undefined || usernameOrChannel === null) && maybeOwner
      ? maybeOwner
      : usernameOrChannel;

    // If no username provided, join for all active bots configured with voice
    if (!username) {
      const results = [];
      for (const [user, client] of this.clients.entries()) {
        if (client && client.isReady && client.isReady()) {
          const res = await this.joinVoice(user);
          results.push({ user, ...res });
        }
      }
      return results.length > 0 ? results[0] : { success: true, message: 'Aktif ses kanalı bulunamadı.' };
    }

    const user = integrationStorage.normalizeUsername(username);
    const client = this.clients.get(user);
    const state = this._getState(user);

    if (!discordPackageAvailable || !client || !client.isReady || !client.isReady()) {
      return {
        success: false,
        error: 'Discord botu çalışmıyor veya bağlı değil. Lütfen önce botu etkinleştirip bağlayın.'
      };
    }

    const cfg = this.getConfig(user);
    if (!cfg.guildId || !cfg.voiceChannelId) {
      return {
        success: false,
        error: 'Bot ayarlarında hem Sunucu ID hem de Ses Kanalı ID yapılandırılmalıdır.'
      };
    }

    try {
      const guild = client.guilds.cache.get(cfg.guildId);
      if (!guild) {
        return {
          success: false,
          error: `Bot, '${cfg.guildId}' kimlikli Discord sunucusunda bulunmuyor.`
        };
      }

      const channel = guild.channels.cache.get(cfg.voiceChannelId);
      if (!channel) {
        return {
          success: false,
          error: `'${cfg.voiceChannelId}' kimlikli ses kanalı sunucuda bulunamadı.`
        };
      }

      const connection = Voice.joinVoiceChannel({
        channelId: cfg.voiceChannelId,
        guildId: cfg.guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true
      });

      this.voiceConnections.set(user, connection);
      this.updatePresence(user, true);

      connection.on('error', (err) => {
        console.error(`[DiscordBotService] '${user}' ses bağlantısı hatası:`, err.message);
        state.lastError = err.message;
      });

      return {
        success: true,
        message: `'${channel.name || cfg.voiceChannelId}' ses kanalına bağlanıldı.`,
        channelId: cfg.voiceChannelId,
        guildId: cfg.guildId
      };
    } catch (err) {
      state.lastError = err.message;
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Leave voice channel for a specific user or all bots if username omitted.
   */
  leaveVoice(username = null) {
    if (!username) {
      for (const [user] of this.voiceConnections.entries()) {
        this.leaveVoice(user);
      }
      return {
        success: true,
        message: 'Tüm ses kanallarından ayrıldı.'
      };
    }

    const user = integrationStorage.normalizeUsername(username);
    this.updatePresence(user, false);
    const conn = this.voiceConnections.get(user);
    if (conn) {
      try {
        conn.destroy();
      } catch (err) {
        console.warn(`[DiscordBotService] '${user}' ses bağlantısı sonlandırılırken hata:`, err.message);
      }
      this.voiceConnections.delete(user);
      return {
        success: true,
        message: 'Ses kanalından başarıyla ayrıldı.'
      };
    }

    return {
      success: true,
      message: 'Bot herhangi bir ses kanalına bağlı değildi.'
    };
  }

  /**
   * Update presence/status and activity.
   */
  updatePresence(username = null, online = undefined) {
    // If username is boolean, legacy call updatePresence(true/false)
    if (typeof username === 'boolean') {
      online = username;
      username = null;
    }

    if (!username) {
      for (const [user] of this.clients.entries()) {
        this.updatePresence(user, online);
      }
      return { success: true };
    }

    const user = integrationStorage.normalizeUsername(username);
    const client = this.clients.get(user);

    if (!discordPackageAvailable || !client || !client.isReady || !client.isReady()) {
      return {
        success: false,
        error: 'Bot bağlı değil.'
      };
    }

    try {
      const cfg = this.getConfig(user);
      let presenceStatus = cfg.status || 'online';
      let activityText = cfg.activityText || 'Minecraft Sunucusu';

      const isOnline = typeof online === 'boolean' ? online : this.isAnyUserServerOnline(user);
      presenceStatus = isOnline ? (cfg.status || 'online') : 'idle';
      activityText = isOnline ? activityText : `${activityText} (Beklemede)`;

      let activityTypeEnum = 0; // Default Playing
      if (Discord.ActivityType) {
        switch (cfg.activityType) {
          case 'Listening':
            activityTypeEnum = Discord.ActivityType.Listening;
            break;
          case 'Watching':
            activityTypeEnum = Discord.ActivityType.Watching;
            break;
          case 'Streaming':
            activityTypeEnum = Discord.ActivityType.Streaming;
            break;
          case 'Playing':
          default:
            activityTypeEnum = Discord.ActivityType.Playing;
            break;
        }
      }

      client.user.setPresence({
        status: presenceStatus,
        activities: [
          {
            name: activityText,
            type: activityTypeEnum
          }
        ]
      });

      return {
        success: true,
        status: presenceStatus,
        activity: activityText
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Get servers belonging to this bot's owner.
   * Ensures the bot only inspects servers owned by that specific user.
   */
  getUserServers(username) {
    const reg = getServerRegistry();
    if (!reg || typeof reg.getAll !== 'function') return [];
    return reg.getAll(integrationStorage.normalizeUsername(username));
  }

  isAnyUserServerOnline(username) {
    try {
      const pm = require('../servers/processManager');
      const servers = this.getUserServers(username);
      return servers.some((s) => {
        const st = pm.getStatus(s.id);
        return Boolean(st && st.status === 'online');
      });
    } catch (e) {
      return true;
    }
  }

  /**
   * Sanitizes input strings before sending to Minecraft server console.
   * Strips all line break variants including CR, LF, and Unicode separators (\u2028, \u2029, \u0085).
   */
  sanitizeConsoleInput(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim();
  }

  /**
   * Whispers a private message to a player on the target server.
   * Player name and message are strictly sanitized against newline injection.
   */
  sendWhisper(username, serverId, playerName, message) {
    const cleanPlayer = this.sanitizeConsoleInput(playerName);
    const cleanMessage = this.sanitizeConsoleInput(message);
    if (!cleanPlayer || !cleanMessage) {
      throw new Error('Oyuncu adı ve mesaj metni gereklidir.');
    }

    const reg = getServerRegistry();
    if (!reg) throw new Error('Sunucu kayıt defterine erişilemedi.');
    const server = reg.getById(serverId);
    if (!server) throw new Error(`'${serverId}' kimlikli sunucu bulunamadı.`);

    const owner = (server.owner || '').trim().toLowerCase();
    const user = integrationStorage.normalizeUsername(username);
    if (owner && owner !== user) {
      throw new Error('Bu sunucuya komut gönderme yetkiniz yok.');
    }

    let processManager = null;
    try {
      processManager = require('../servers/processManager');
    } catch (e) {}

    if (!processManager) {
      throw new Error('İşlem yöneticisi bulunamadı.');
    }

    return processManager.sendCommand(serverId, `tell ${cleanPlayer} ${cleanMessage}`);
  }

  /**
   * Cleans up all pending timers and disconnects active bot connections on service shutdown.
   */
  close() {
    if (this.initTimeout) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }
    for (const user of Array.from(this.clients.keys())) {
      this.stop(user);
    }
  }
}

const discordBotService = new DiscordBotService();
module.exports = discordBotService;
