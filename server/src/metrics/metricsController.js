const express = require('express');
const router = express.Router();
const metricsService = require('./metricsService');
const authMiddleware = require('../auth/authMiddleware');
const serverRegistry = require('../servers/serverRegistry');

function canAccessServer(user, server) {
  if (!user || !server) return false;
  if (user.role === 'admin') return true;
  const userNorm = (user.username || '').trim().toLowerCase();
  const ownerNorm = (server.owner || '').trim().toLowerCase();
  return Boolean(userNorm && userNorm === ownerNorm);
}

router.use(authMiddleware);

router.get('/host', (req, res) => {
  try {
    const metrics = metricsService.getHostMetrics();
    if (req.user && req.user.role !== 'admin') {
      // Non-admin users: strip host system details (hostname, OS, kernel, CPU model, disks, network, software)
      return res.json({
        cpu: {
          usagePercent: metrics.cpu.usagePercent
        },
        memory: {
          totalBytes: metrics.memory.totalBytes,
          usedBytes: metrics.memory.usedBytes,
          freeBytes: metrics.memory.freeBytes,
          usagePercent: metrics.memory.usagePercent
        },
        timestamp: metrics.timestamp
      });
    }
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/server/:id', (req, res) => {
  try {
    const server = serverRegistry.getById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    }
    if (!canAccessServer(req.user, server)) {
      return res.status(403).json({ error: 'Bu sunucuya erişim yetkiniz yok.' });
    }
    const metrics = metricsService.getServerMetrics(req.params.id);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Energy History & Archive APIs - Admin only
router.get('/energy/history', authMiddleware.requireAdmin, (req, res) => {
  try {
    const data = metricsService.getEnergyHistory(req.query.range);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/energy/reset', authMiddleware.requireAdmin, (req, res) => {
  try {
    const result = metricsService.resetEnergyData();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/energy/archives/:id', authMiddleware.requireAdmin, (req, res) => {
  try {
    const archive = metricsService.getArchive(req.params.id);
    res.json(archive);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete('/energy/archives/:id', authMiddleware.requireAdmin, (req, res) => {
  try {
    const result = metricsService.deleteArchive(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/energy/refresh-tariff', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const tariff = await metricsService.refreshEpdkTariffAsync(true);
    res.json({ success: true, tariff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


