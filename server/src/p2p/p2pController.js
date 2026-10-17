const express = require('express');
const router = express.Router();
const authMiddleware = require('../auth/authMiddleware');
const p2pService = require('./p2pService');

router.use(authMiddleware);
router.use(authMiddleware.requireAdmin);

// GET /api/p2p/status
router.get('/status', async (req, res) => {
  try {
    const overview = await p2pService.getOverview();
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: err.message || 'P2P durumu alınamadı.' });
  }
});

// POST /api/p2p/service & /api/p2p/service/:action
const handleServiceControl = async (req, res) => {
  try {
    const action = req.params.action || (req.body && req.body.action);
    const controlResult = await p2pService.controlService(action);
    const overview = await p2pService.getOverview();
    res.json({
      success: true,
      action,
      message: (controlResult && controlResult.message) || `p2ptunnel.service ${action} komutu uygulandı.`,
      status: overview
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Servis işlemi başarısız oldu.' });
  }
};
router.post('/service', handleServiceControl);
router.post('/service/:action', handleServiceControl);

// POST /api/p2p/kick
router.post('/kick', async (req, res) => {
  try {
    const result = await p2pService.kickClient(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'İstemci atılamadı.' });
  }
});

// POST /api/p2p/ban
router.post('/ban', async (req, res) => {
  try {
    const result = await p2pService.banClient(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'İstemci yasaklanamadı.' });
  }
});

// POST /api/p2p/unban
router.post('/unban', async (req, res) => {
  try {
    const result = await p2pService.unbanClient(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Yasak kaldırılamadı.' });
  }
});

// POST /api/p2p/clear-history & /api/p2p/clear_history
const handleClearHistory = async (req, res) => {
  try {
    const result = await p2pService.clearHistory();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Geçmiş temizlenemedi.' });
  }
};
router.post('/clear-history', handleClearHistory);
router.post('/clear_history', handleClearHistory);

// POST /api/p2p/regenerate-key & /api/p2p/regenerate_key
const handleRegenerateKey = async (req, res) => {
  try {
    const result = await p2pService.regenerateKey();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Anahtar yenilenemedi.' });
  }
};
router.post('/regenerate-key', handleRegenerateKey);
router.post('/regenerate_key', handleRegenerateKey);

// POST & PUT /api/p2p/settings
const handleSaveSettings = async (req, res) => {
  try {
    const result = await p2pService.updateSettings(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Ayarlar kaydedilemedi.' });
  }
};
router.post('/settings', handleSaveSettings);
router.put('/settings', handleSaveSettings);

// POST /api/p2p/version/refresh
router.post('/version/refresh', async (req, res) => {
  try {
    const result = await p2pService.refreshVersion();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Sürüm bilgisi yenilenemedi.' });
  }
});

module.exports = router;
