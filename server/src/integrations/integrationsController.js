const express = require('express');
const router = express.Router();
const authMiddleware = require('../auth/authMiddleware');
const webhookService = require('./webhookService');
const discordBotService = require('./discordBotService');

// All integrations routes require authentication
router.use(authMiddleware);

// Middleware to extract authenticated username
function getRequestUser(req) {
  const username = req.user?.username;
  if (!username || typeof username !== 'string' || !username.trim()) {
    return null;
  }
  return username.trim().toLowerCase();
}

// ==========================================
// 1. WEBHOOKS API (Per-user scoped)
// ==========================================

// GET /api/integrations/webhooks - List all webhooks for current user
router.get('/webhooks', (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const webhooks = webhookService.getAll(username);
    res.json(webhooks);
  } catch (err) {
    console.error('[IntegrationsController] Webhook listeleme hatası:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/integrations/webhooks - Create a new webhook for current user
router.post('/webhooks', async (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const created = await webhookService.create(req.body, username);
    res.status(201).json(created);
  } catch (err) {
    console.warn('[IntegrationsController] Webhook oluşturma hatası:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/integrations/webhooks/:id - Get webhook by ID for current user
router.get('/webhooks/:id', (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const webhook = webhookService.getById(req.params.id, username);
    if (!webhook) {
      return res.status(404).json({ error: `'${req.params.id}' kimlikli webhook bulunamadı.` });
    }
    res.json(webhook);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/integrations/webhooks/:id - Update an existing webhook for current user
router.put('/webhooks/:id', async (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const updated = await webhookService.update(req.params.id, req.body, username);
    res.json(updated);
  } catch (err) {
    const isNotFound = err.message && (err.message.includes('bulunamadı') || err.message.includes('not found'));
    res.status(isNotFound ? 404 : 400).json({ error: err.message });
  }
});

// DELETE /api/integrations/webhooks/:id - Delete a webhook for current user
router.delete('/webhooks/:id', (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const deleted = webhookService.delete(req.params.id, username);
    res.json({ success: true, deleted });
  } catch (err) {
    const isNotFound = err.message && (err.message.includes('bulunamadı') || err.message.includes('not found'));
    res.status(isNotFound ? 404 : 400).json({ error: err.message });
  }
});

// POST /api/integrations/webhooks/:id/test - Send a test ping to webhook
router.post('/webhooks/:id/test', async (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const result = await webhookService.testWebhook(req.params.id, username);
    res.json(result);
  } catch (err) {
    const isNotFound = err.message && (err.message.includes('bulunamadı') || err.message.includes('not found'));
    res.status(isNotFound ? 404 : 500).json({ error: err.message });
  }
});

// ==========================================
// 2. DISCORD BOT API (Per-user scoped)
// ==========================================

// GET /api/integrations/discord - Get bot configuration and connection status for current user
router.get('/discord', (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const config = discordBotService.getPublicConfig(username);
    const status = discordBotService.getStatus(username);
    res.json({ config, status });
  } catch (err) {
    console.error('[IntegrationsController] Discord durumu alınırken hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/integrations/discord - Update bot configuration for current user
router.put('/discord', async (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const updated = await discordBotService.updateConfig(username, req.body);
    const status = discordBotService.getStatus(username);
    res.json({
      success: true,
      config: updated,
      status
    });
  } catch (err) {
    console.error('[IntegrationsController] Discord yapılandırması güncellenirken hata:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/integrations/discord/test - Test bot token connection
router.post('/discord/test', async (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const tokenOverride = req.body?.token ? String(req.body.token).trim() : null;
    const result = await discordBotService.testConnection(username, tokenOverride);
    res.json(result);
  } catch (err) {
    console.error('[IntegrationsController] Discord bağlantısı test edilirken hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/integrations/discord/voice/join - Join configured voice channel
router.post('/discord/voice/join', async (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const result = await discordBotService.joinVoice(username);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[IntegrationsController] Ses kanalına bağlanırken hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/integrations/discord/voice/leave - Leave voice channel
router.post('/discord/voice/leave', (req, res) => {
  const username = getRequestUser(req);
  if (!username) {
    return res.status(401).json({ error: 'Kimlik doğrulaması gereklidir.' });
  }

  try {
    const result = discordBotService.leaveVoice(username);
    res.json(result);
  } catch (err) {
    console.error('[IntegrationsController] Ses kanalından ayrılırken hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
