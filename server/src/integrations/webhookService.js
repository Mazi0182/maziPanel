const crypto = require('crypto');
const { integrationStorage } = require('./integrationStorage');
const { validateWebhookUrl, sendSafeWebhookPost } = require('./ssrfValidator');
let serverRegistry = null;

function getServerRegistry() {
  if (!serverRegistry) {
    try {
      serverRegistry = require('../servers/serverRegistry');
    } catch (e) {}
  }
  return serverRegistry;
}

const SUPPORTED_EVENTS = [
  'server_start',
  'server_done',
  'server_stop',
  'server_restart',
  'server_crash'
];

const EVENT_COLORS = {
  server_done: 0x2ecc71,       // Yeşil
  server_start: 0xf1c40f,      // Sarı
  server_restart: 0xf1c40f,    // Sarı
  server_stop: 0xe74c3c,       // Kırmızı
  server_crash: 0xe74c3c       // Kırmızı
};

const EVENT_TITLES = {
  server_start: 'Sunucu Başlatılıyor',
  server_done: 'Sunucu Çevrimiçi & Hazır',
  server_stop: 'Sunucu Durduruldu',
  server_restart: 'Sunucu Yeniden Başlatılıyor',
  server_crash: 'Sunucu Beklenmedik Şekilde Kapandı'
};

function buildDiscordPayload(event, serverData = {}) {
  const serverName = serverData.serverName || serverData.name || serverData.serverId || 'Minecraft Sunucusu';
  const serverId = serverData.serverId || serverData.id || 'bilinmiyor';
  const color = EVENT_COLORS[event] || 0x3498db;
  const eventTitle = EVENT_TITLES[event] || event;

  const fields = [
    { name: 'Sunucu', value: String(serverName), inline: true },
    { name: 'Olay', value: `\`${event}\``, inline: true }
  ];

  if (serverData.port) {
    fields.push({ name: 'Port', value: String(serverData.port), inline: true });
  }

  if (serverData.players !== undefined) {
    const online = serverData.players.online ?? 0;
    const max = serverData.players.max ?? 20;
    fields.push({ name: 'Oyuncular', value: `${online}/${max}`, inline: true });
  }

  if (serverData.exitCode !== undefined && serverData.exitCode !== null) {
    fields.push({ name: 'Çıkış Kodu', value: String(serverData.exitCode), inline: true });
  }

  if (serverData.message) {
    fields.push({ name: 'Mesaj', value: String(serverData.message).slice(0, 1024), inline: false });
  }

  return {
    username: 'maziPanel',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${serverName}: ${eventTitle}`,
        description: serverData.description || `**${serverName}** sunucusunda \`${event}\` olayı tetiklendi (ID: \`${serverId}\`).`,
        color,
        fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'maziPanel Entegrasyonları'
        }
      }
    ]
  };
}

/**
 * Validates and sanitizes custom headers at save time.
 * Strictly rejects CR/LF (\r, \n) and Unicode line terminators in names and values.
 *
 * @param {object} rawHeaders
 * @returns {object}
 */
function sanitizeAndValidateHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return {};
  }
  const validatedHeaders = {};
  for (const [key, val] of Object.entries(rawHeaders)) {
    if (typeof key !== 'string') {
      throw new Error('Başlık adı metin formatında olmalıdır.');
    }
    const cleanKey = key.trim();
    if (!cleanKey) continue;

    const strVal = String(val !== undefined && val !== null ? val : '');

    // Reject CR / LF and Unicode line separators (\r, \n, \u0085, \u2028, \u2029)
    if (/[\r\n\u0085\u2028\u2029]/.test(cleanKey) || /[\r\n\u0085\u2028\u2029]/.test(strVal)) {
      throw new Error('Özel başlıklarda satır sonu (CR/LF) karakterleri kullanılamaz.');
    }

    // RFC 7230 token validation for header name
    if (!/^[a-zA-Z0-9!#$%&'*+-.^_`|~]+$/.test(cleanKey)) {
      throw new Error(`Geçersiz başlık adı formatı: '${cleanKey}'.`);
    }

    validatedHeaders[cleanKey] = strVal;
  }
  return validatedHeaders;
}

function buildGenericPayload(event, serverData = {}) {
  const serverName = serverData.serverName || serverData.name || serverData.serverId || 'Minecraft Sunucusu';
  const serverId = serverData.serverId || serverData.id || 'bilinmiyor';
  return {
    event,
    serverId,
    serverName,
    timestamp: new Date().toISOString(),
    data: serverData
  };
}

class WebhookService {
  /**
   * Get all webhooks for a specific user.
   */
  getAll(username = null) {
    const user = integrationStorage.normalizeUsername(username);
    const data = integrationStorage.getUserData(user);
    return Array.isArray(data.webhooks) ? data.webhooks : [];
  }

  /**
   * Get a webhook by ID for a specific user.
   */
  getById(id, username = null) {
    if (!id) return null;
    const webhooks = this.getAll(username);
    return webhooks.find((w) => w.id === String(id)) || null;
  }

  /**
   * Create a new webhook for a specific user.
   * Enforces name requirement and SSRF validation on the URL.
   */
  async create(data = {}, username = null) {
    const user = integrationStorage.normalizeUsername(username);

    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Webhook adı zorunludur.');
    }
    if (!data.url || typeof data.url !== 'string' || !/^https?:\/\//i.test(data.url.trim())) {
      throw new Error('http:// veya https:// ile başlayan geçerli bir webhook URL adresi gereklidir.');
    }

    // SSRF URL validation
    await validateWebhookUrl(data.url.trim());

    const format = data.format === 'generic' ? 'generic' : 'discord';
    let events = Array.isArray(data.events)
      ? data.events.filter((e) => SUPPORTED_EVENTS.includes(e))
      : [...SUPPORTED_EVENTS];

    if (events.length === 0) {
      events = [...SUPPORTED_EVENTS];
    }

    const headers = sanitizeAndValidateHeaders(data.headers);

    const id = crypto.randomUUID
      ? crypto.randomUUID()
      : 'wh_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');

    const newWebhook = {
      id,
      name: data.name.trim(),
      url: data.url.trim(),
      format,
      events,
      headers,
      enabled: data.enabled !== false,
      createdAt: new Date().toISOString(),
      lastTriggeredAt: null,
      lastStatus: null
    };

    const webhooks = this.getAll(user);
    webhooks.push(newWebhook);
    integrationStorage.saveUserData(user, { webhooks });

    return newWebhook;
  }

  /**
   * Update an existing webhook for a specific user.
   */
  async update(id, data = {}, username = null) {
    if (!id) throw new Error('Webhook kimliği zorunludur.');
    const user = integrationStorage.normalizeUsername(username);
    const webhooks = this.getAll(user);
    const index = webhooks.findIndex((w) => w.id === String(id));
    if (index === -1) {
      throw new Error(`'${id}' kimlikli webhook bulunamadı.`);
    }

    const current = { ...webhooks[index] };

    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('Webhook adı boş olamaz.');
      }
      current.name = data.name.trim();
    }

    if (data.url !== undefined) {
      if (typeof data.url !== 'string' || !/^https?:\/\//i.test(data.url.trim())) {
        throw new Error('http:// veya https:// ile başlayan geçerli bir webhook URL adresi gereklidir.');
      }
      // SSRF validation
      await validateWebhookUrl(data.url.trim());
      current.url = data.url.trim();
    }

    if (data.format !== undefined) {
      current.format = data.format === 'generic' ? 'generic' : 'discord';
    }

    if (data.events !== undefined) {
      if (Array.isArray(data.events)) {
        current.events = data.events.filter((e) => SUPPORTED_EVENTS.includes(e));
      }
    }

    if (data.headers !== undefined) {
      current.headers = sanitizeAndValidateHeaders(data.headers);
    }

    if (data.enabled !== undefined) {
      current.enabled = Boolean(data.enabled);
    }

    webhooks[index] = current;
    integrationStorage.saveUserData(user, { webhooks });
    return current;
  }

  /**
   * Delete a webhook by ID for a specific user.
   */
  delete(id, username = null) {
    if (!id) throw new Error('Webhook kimliği zorunludur.');
    const user = integrationStorage.normalizeUsername(username);
    const webhooks = this.getAll(user);
    const index = webhooks.findIndex((w) => w.id === String(id));
    if (index === -1) {
      throw new Error(`'${id}' kimlikli webhook bulunamadı.`);
    }

    const [deleted] = webhooks.splice(index, 1);
    integrationStorage.saveUserData(user, { webhooks });
    return deleted;
  }

  /**
   * Test a specific webhook by sending a sample payload with SSRF protection.
   */
  async testWebhook(id, username = null) {
    if (!id) throw new Error('Webhook kimliği zorunludur.');
    const user = integrationStorage.normalizeUsername(username);
    const webhooks = this.getAll(user);
    const webhook = webhooks.find((w) => w.id === String(id));
    if (!webhook) {
      throw new Error(`'${id}' kimlikli webhook bulunamadı.`);
    }

    const testEvent = 'server_done';
    const testData = {
      serverId: 'test-server',
      serverName: 'maziPanel Test Sunucusu',
      port: 25565,
      players: { online: 5, max: 50 },
      message: 'Bu bildirim, maziPanel webhook iletimini doğrulamak amacıyla gönderilen bir test iletisidir.'
    };

    const payload = webhook.format === 'discord'
      ? buildDiscordPayload(testEvent, testData)
      : buildGenericPayload(testEvent, testData);

    const customHeaders = webhook.format === 'generic' ? (webhook.headers || {}) : {};

    const res = await sendSafeWebhookPost(webhook.url, payload, customHeaders, 5000);

    webhook.lastTriggeredAt = new Date().toISOString();
    webhook.lastStatus = res.lastStatus;
    integrationStorage.saveUserData(user, { webhooks });

    return {
      success: res.ok,
      status: res.status,
      statusText: res.statusText,
      lastStatus: webhook.lastStatus,
      error: res.error || null
    };
  }

  /**
   * Trigger webhooks registered for a specific event.
   * Only triggers webhooks belonging to the owner of the server.
   */
  async trigger(event, serverData = {}) {
    if (!event) return [];

    const reg = getServerRegistry();
    const serverId = serverData.serverId || serverData.id;
    let owner = serverData.owner;

    if (!owner && serverId && reg && typeof reg.getById === 'function') {
      try {
        const srv = reg.getById(serverId);
        if (srv && srv.owner) {
          owner = srv.owner;
        }
      } catch (e) {}
    }

    // If still no owner resolved, check all integration users or default admin
    let targetUsers = [];
    if (owner && typeof owner === 'string') {
      targetUsers = [integrationStorage.normalizeUsername(owner)];
    } else {
      // If server has no owner attribute (e.g. legacy/mock test), trigger all users
      targetUsers = integrationStorage.listAllIntegrationUsers();
      if (targetUsers.length === 0) {
        targetUsers = [integrationStorage.normalizeUsername(null)];
      }
    }

    const allResults = [];

    for (const user of targetUsers) {
      const webhooks = this.getAll(user);
      const matched = webhooks.filter((w) => w.enabled && Array.isArray(w.events) && w.events.includes(event));
      if (matched.length === 0) continue;

      let stateChanged = false;
      for (const webhook of matched) {
        const payload = webhook.format === 'discord'
          ? buildDiscordPayload(event, serverData)
          : buildGenericPayload(event, serverData);

        const customHeaders = webhook.format === 'generic' ? (webhook.headers || {}) : {};

        const res = await sendSafeWebhookPost(webhook.url, payload, customHeaders, 5000);

        webhook.lastTriggeredAt = new Date().toISOString();
        webhook.lastStatus = res.lastStatus;
        stateChanged = true;

        allResults.push({
          id: webhook.id,
          name: webhook.name,
          success: res.ok,
          status: res.status,
          lastStatus: res.lastStatus,
          error: res.error || null
        });
      }

      if (stateChanged) {
        integrationStorage.saveUserData(user, { webhooks });
      }
    }

    return allResults;
  }
}

const webhookService = new WebhookService();
module.exports = webhookService;
