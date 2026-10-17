const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync, spawnSync, execFile } = require('child_process');
const config = require('../../config');
const processManager = require('../servers/processManager');
const javaDetector = require('../system/javaDetector');

class MetricsService {
  constructor() {
    this._prevCpuTimes = this._getCpuTimes();
    this._cpuUsage = 0;
    this._prevPidTimes = new Map(); // pid -> { utime, stime, timestamp }

    this._statsFilePath = path.join(config.DATA_DIR, 'energy-stats.json');
    this._tariffFilePath = path.join(config.DATA_DIR, 'epdk-tariff.json');
    this._archiveDir = path.join(config.DATA_DIR, 'energy-archive');
    if (!fs.existsSync(this._archiveDir)) {
      try {
        fs.mkdirSync(this._archiveDir, { recursive: true });
      } catch (e) {}
    }
    this._hourlyBuckets = [];
    this._currentMinute = null;

    this._cachedTariff = null;
    this._tariffRefreshInProgress = false;
    this._loadCachedTariff();

    // Refresh EPDK tariff in background on startup and every 12 hours
    const initTariffTimer = setTimeout(() => {
      this.refreshEpdkTariffAsync(false).catch(() => {});
    }, 1500);
    if (initTariffTimer.unref) initTariffTimer.unref();

    this._tariffTimer = setInterval(() => {
      this.refreshEpdkTariffAsync(false).catch(() => {});
    }, 12 * 60 * 60 * 1000);
    if (this._tariffTimer.unref) this._tariffTimer.unref();

    // Cache expensive software version commands once at startup
    this._cachedSsh = null;
    this._cachedSystemd = null;
    this._initSoftwareCache();

    // Cache disk metrics with async 30s refresh
    this._cachedDiskMetrics = null;
    this._lastDiskCheck = 0;
    this._diskCheckInProgress = false;
    this._refreshDiskMetricsAsync();
    this._diskTimer = setInterval(() => this._refreshDiskMetricsAsync(), 30000);
    if (this._diskTimer.unref) {
      this._diskTimer.unref();
    }

    // Load persisted energy buckets
    this._loadEnergyStats();

    // Periodically update host CPU calculation every 2 seconds
    setInterval(() => {
      this._updateHostCpu();
    }, 2000);

    // Take an energy consumption sample every 10 seconds
    setInterval(() => {
      this._recordSample();
    }, 10000);

    // Periodically persist energy stats every 5 minutes
    setInterval(() => {
      this.flushAndSaveStats();
    }, 5 * 60 * 1000);

    // Handle shutdown gracefully by flushing and saving
    process.on('SIGTERM', () => this.flushAndSaveStats());
    process.on('SIGINT', () => this.flushAndSaveStats());
  }

  _getCpuTimes() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  _updateHostCpu() {
    const current = this._getCpuTimes();
    const idleDiff = current.idle - this._prevCpuTimes.idle;
    const totalDiff = current.total - this._prevCpuTimes.total;
    if (totalDiff > 0) {
      const usage = 100 - Math.round((100 * idleDiff) / totalDiff);
      this._cpuUsage = Math.max(0, Math.min(100, usage));
    }
    this._prevCpuTimes = current;
  }

  _getHostMemory() {
    let totalMem = os.totalmem();
    let freeMem = os.freemem();
    let availableMem = freeMem;

    if (fs.existsSync('/proc/meminfo')) {
      try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const matchTotal = meminfo.match(/MemTotal:\s+(\d+)\s+kB/i);
        const matchAvail = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/i);
        const matchFree = meminfo.match(/MemFree:\s+(\d+)\s+kB/i);
        if (matchTotal) totalMem = parseInt(matchTotal[1], 10) * 1024;
        if (matchAvail) {
          availableMem = parseInt(matchAvail[1], 10) * 1024;
        } else if (matchFree) {
          availableMem = parseInt(matchFree[1], 10) * 1024;
        }
      } catch (e) {}
    }

    const usedMem = Math.max(0, totalMem - availableMem);
    const memUsagePct = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

    return { totalMem, usedMem, availableMem, memUsagePct };
  }

  _readHardwareSensorWatts() {
    // 1. Try Linux RAPL powercap (package energy in microjoules) if readable
    const raplPaths = [
      '/sys/class/powercap/intel-rapl:0/energy_uj',
      '/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0/energy_uj'
    ];
    for (const raplPath of raplPaths) {
      try {
        if (fs.existsSync(raplPath)) {
          const raw = fs.readFileSync(raplPath, 'utf8').trim();
          const energyUj = parseInt(raw, 10);
          if (!isNaN(energyUj) && energyUj >= 0) {
            const now = Date.now();
            if (this._prevRaplSample && now > this._prevRaplSample.timestamp) {
              const dtSec = (now - this._prevRaplSample.timestamp) / 1000;
              let dEnergyUj = energyUj - this._prevRaplSample.energyUj;
              if (dEnergyUj < 0) {
                try {
                  const maxRangePath = path.join(path.dirname(raplPath), 'max_energy_range_uj');
                  const maxRange = parseInt(fs.readFileSync(maxRangePath, 'utf8').trim(), 10);
                  if (!isNaN(maxRange) && maxRange > 0) {
                    dEnergyUj += maxRange;
                  }
                } catch (e) {}
              }
              if (dtSec >= 0.25 && dEnergyUj >= 0) {
                const watts = (dEnergyUj / 1e6) / dtSec;
                if (watts > 0.5 && watts < 250) {
                  this._lastRaplWatts = Math.round(watts * 10) / 10;
                }
              }
            }
            this._prevRaplSample = { energyUj, timestamp: now };
            if (this._lastRaplWatts !== undefined) {
              return this._lastRaplWatts;
            }
          }
        }
      } catch (e) {
        // Permission denied or unreadable without root
      }
    }

    // 2. Try hwmon power1_average or power1_input (in microwatts)
    const hwmonDir = '/sys/class/hwmon';
    try {
      if (fs.existsSync(hwmonDir)) {
        const entries = fs.readdirSync(hwmonDir);
        for (const entry of entries) {
          for (const file of ['power1_average', 'power1_input']) {
            const pPath = path.join(hwmonDir, entry, file);
            if (fs.existsSync(pPath)) {
              const valUw = parseInt(fs.readFileSync(pPath, 'utf8').trim(), 10);
              if (!isNaN(valUw) && valUw > 500000 && valUw < 250000000) {
                return Math.round((valUw / 1e6) * 10) / 10;
              }
            }
          }
        }
      }
    } catch (e) {}

    return null;
  }

  _getCpuFreqFactor() {
    const cpuFreqDir = '/sys/devices/system/cpu/cpufreq';
    try {
      if (!fs.existsSync(cpuFreqDir)) return 1.0;
      const policies = fs.readdirSync(cpuFreqDir).filter((p) => p.startsWith('policy'));
      if (policies.length === 0) return 1.0;

      let ratioSum = 0;
      let count = 0;
      for (const pol of policies) {
        const curPath = path.join(cpuFreqDir, pol, 'scaling_cur_freq');
        const maxPath = path.join(cpuFreqDir, pol, 'scaling_max_freq');
        if (fs.existsSync(curPath) && fs.existsSync(maxPath)) {
          const cur = parseInt(fs.readFileSync(curPath, 'utf8').trim(), 10);
          const max = parseInt(fs.readFileSync(maxPath, 'utf8').trim(), 10);
          if (!isNaN(cur) && !isNaN(max) && max > 0) {
            ratioSum += Math.min(1.2, Math.max(0.1, cur / max));
            count++;
          }
        }
      }
      if (count > 0) {
        return ratioSum / count;
      }
    } catch (e) {}
    return 1.0;
  }

  _getGoldPsuEfficiency(dcWatts) {
    const energyCfg = config.ENERGY || {};
    if (process.env.ENERGY_PSU_EFFICIENCY) {
      const custom = parseFloat(process.env.ENERGY_PSU_EFFICIENCY);
      if (!isNaN(custom) && custom > 0.4 && custom <= 1.0) return custom;
    }
    // 80+ Gold (230V EU) dynamic efficiency curve:
    // ~85% at 17W ultra-low idle load -> scales smoothly up to 91.5% at >=65W load
    const clampedDc = Math.max(12, Math.min(120, dcWatts || 18));
    const eff = 0.845 + ((clampedDc - 15) / 85) * 0.07;
    return Math.min(0.915, Math.max(0.84, eff));
  }

  _calculateInstantWatts(cpuUsage, usedMem, totalMem) {
    const energyCfg = config.ENERGY || {};
    const boardBaseW = energyCfg.BOARD_BASE_W !== undefined ? energyCfg.BOARD_BASE_W : 11.5;
    const ramW = energyCfg.RAM_W !== undefined ? energyCfg.RAM_W : 2.5;
    const ramRatio = totalMem > 0 ? (usedMem / totalMem) : 0;
    const ramDcWatts = ramRatio * ramW;

    const sensorCpuWatts = this._readHardwareSensorWatts();
    if (sensorCpuWatts !== null) {
      // Total Wall Power = (RAPL CPU Package + Board/Chipset/NVMe/Fans + Active RAM) / 80+ Gold Dynamic PSU Efficiency
      const totalDcWatts = sensorCpuWatts + boardBaseW + ramDcWatts;
      const psuEff = this._getGoldPsuEfficiency(totalDcWatts);
      const wallWatts = totalDcWatts / psuEff;
      return Math.round(wallWatts * 10) / 10;
    }

    const idleW = energyCfg.IDLE_W !== undefined ? energyCfg.IDLE_W : 18.2;
    const dynamicW = energyCfg.CPU_DYNAMIC_W !== undefined ? energyCfg.CPU_DYNAMIC_W : 42;

    const loadRatio = Math.max(0, Math.min(1, (cpuUsage || 0) / 100));
    const freqFactor = this._getCpuFreqFactor();
    const effectiveCpuFactor = Math.pow(loadRatio, 1.15) * (0.55 + 0.45 * freqFactor);

    const raw = idleW + effectiveCpuFactor * dynamicW + (ramDcWatts / 0.86);
    return Math.round(raw * 10) / 10;
  }

  _recordSample() {
    const mem = this._getHostMemory();
    const cpu = this._cpuUsage;
    const watts = this._calculateInstantWatts(cpu, mem.usedMem, mem.totalMem);

    let totalPlayers = 0;
    let runningServers = 0;
    try {
      const statuses = processManager.getAllStatuses();
      for (const id in statuses) {
        const st = statuses[id];
        if (st.status === 'online' || st.running) {
          runningServers++;
        }
        if (Array.isArray(st.onlinePlayers)) {
          totalPlayers += st.onlinePlayers.length;
        }
      }
    } catch (e) {}

    this._addSampleToMinute({ watts, cpu, players: totalPlayers, runningServers });
  }

  _addSampleToMinute(sample) {
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
    const mIso = mStart.toISOString();

    if (this._currentMinute && this._currentMinute.start !== mIso) {
      this._flushMinuteToHour(this._currentMinute);
      this._currentMinute = null;
      this._saveEnergyStats();
    }

    if (!this._currentMinute) {
      this._currentMinute = {
        start: mIso,
        sampleCount: 0,
        wattSum: 0,
        cpuSum: 0,
        playerSum: 0,
        idleSamples: 0,
        idleWattSum: 0,
        activeSamples: 0,
        activeWattSum: 0
      };
    }

    const m = this._currentMinute;
    m.sampleCount++;
    m.wattSum += sample.watts;
    m.cpuSum += sample.cpu;
    m.playerSum += sample.players;
    if (sample.players === 0) {
      m.idleSamples++;
      m.idleWattSum += sample.watts;
    } else {
      m.activeSamples++;
      m.activeWattSum += sample.watts;
    }
  }

  _flushMinuteToHour(minute) {
    if (!minute || minute.sampleCount === 0) return;
    const mDate = new Date(minute.start);
    const hStart = new Date(mDate.getFullYear(), mDate.getMonth(), mDate.getDate(), mDate.getHours(), 0, 0, 0);
    const hIso = hStart.toISOString();

    let hourBucket = this._hourlyBuckets.find((b) => b.start === hIso);
    if (!hourBucket) {
      hourBucket = {
        start: hIso,
        sampleCount: 0,
        avgWatts: 0,
        avgCpu: 0,
        avgPlayers: 0,
        idleSamples: 0,
        idleWattSum: 0,
        activeSamples: 0,
        activeWattSum: 0,
        _wattSum: 0,
        _cpuSum: 0,
        _playerSum: 0
      };
      this._hourlyBuckets.push(hourBucket);
    }

    if (hourBucket._wattSum === undefined) {
      hourBucket._wattSum = (hourBucket.idleWattSum || 0) + (hourBucket.activeWattSum || 0);
      hourBucket._cpuSum = (hourBucket.avgCpu || 0) * (hourBucket.sampleCount || 0);
      hourBucket._playerSum = (hourBucket.avgPlayers || 0) * (hourBucket.sampleCount || 0);
    }

    hourBucket.sampleCount += minute.sampleCount;
    hourBucket._wattSum += minute.wattSum;
    hourBucket._cpuSum += minute.cpuSum;
    hourBucket._playerSum += minute.playerSum;
    hourBucket.idleSamples += minute.idleSamples;
    hourBucket.idleWattSum = Number(((hourBucket.idleWattSum || 0) + minute.idleWattSum).toFixed(2));
    hourBucket.activeSamples += minute.activeSamples;
    hourBucket.activeWattSum = Number(((hourBucket.activeWattSum || 0) + minute.activeWattSum).toFixed(2));

    hourBucket.avgWatts = hourBucket.sampleCount > 0
      ? Number((hourBucket._wattSum / hourBucket.sampleCount).toFixed(2))
      : 0;
    hourBucket.avgCpu = hourBucket.sampleCount > 0
      ? Number((hourBucket._cpuSum / hourBucket.sampleCount).toFixed(2))
      : 0;
    hourBucket.avgPlayers = hourBucket.sampleCount > 0
      ? Number((hourBucket._playerSum / hourBucket.sampleCount).toFixed(2))
      : 0;
  }

  flushAndSaveStats() {
    if (this._currentMinute && this._currentMinute.sampleCount > 0) {
      this._flushMinuteToHour(this._currentMinute);
      this._currentMinute = null;
    }
    this._saveEnergyStats();
  }

  _saveEnergyStats() {
    try {
      const cutoff35d = Date.now() - (35 * 24 * 60 * 60 * 1000);
      this._hourlyBuckets = this._hourlyBuckets.filter(
        (b) => b && b.start && new Date(b.start).getTime() >= cutoff35d
      );
      this._hourlyBuckets.sort((a, b) => new Date(a.start) - new Date(b.start));

      const cleanList = this._hourlyBuckets.map((b) => ({
        start: b.start,
        sampleCount: b.sampleCount,
        avgWatts: b.avgWatts,
        avgCpu: b.avgCpu,
        avgPlayers: b.avgPlayers,
        idleSamples: b.idleSamples,
        idleWattSum: b.idleWattSum,
        activeSamples: b.activeSamples,
        activeWattSum: b.activeWattSum
      }));

      const tmpFile = `${this._statsFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(cleanList, null, 2), 'utf8');
      fs.renameSync(tmpFile, this._statsFilePath);
    } catch (err) {
      console.error('[MetricsService] Failed to save energy stats:', err.message);
    }
  }

  _loadEnergyStats() {
    if (!fs.existsSync(this._statsFilePath)) {
      this._hourlyBuckets = [];
      this._saveEnergyStats();
      return;
    }
    try {
      const data = fs.readFileSync(this._statsFilePath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        const cutoff35d = Date.now() - (35 * 24 * 60 * 60 * 1000);
        this._hourlyBuckets = parsed
          .filter((b) => b && b.start && new Date(b.start).getTime() >= cutoff35d)
          .map((b) => ({
            ...b,
            _wattSum: (b.idleWattSum || 0) + (b.activeWattSum || 0),
            _cpuSum: (b.avgCpu || 0) * (b.sampleCount || 0),
            _playerSum: (b.avgPlayers || 0) * (b.sampleCount || 0)
          }));
      }
    } catch (err) {
      console.error('[MetricsService] Failed to parse energy stats, initializing empty:', err.message);
      this._hourlyBuckets = [];
    }
  }

  _getDefaultTariff() {
    const tariffCfg = (config.ENERGY && config.ENERGY.TARIFF) || {};
    return {
      lowRate: Number(tariffCfg.LOW_RATE) || 3.24,
      highRate: Number(tariffCfg.HIGH_RATE) || 4.32,
      sktRate: Number(tariffCfg.SKTT_RATE) || 4.86,
      lowTierLimitKwh: Number(tariffCfg.LOW_TIER_LIMIT_KWH) || 240,
      annualLimitKwh: Number(tariffCfg.ANNUAL_LIMIT_KWH) || 4000,
      source: tariffCfg.SOURCE || 'EPDK Güncel Mesken Tarifesi',
      updatedAt: null,
      liveVerified: false
    };
  }

  _loadCachedTariff() {
    const def = this._getDefaultTariff();
    if (!fs.existsSync(this._tariffFilePath)) {
      this._cachedTariff = { ...def };
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this._tariffFilePath, 'utf8'));
      const lowRate = Number(raw?.lowRate);
      const highRate = Number(raw?.highRate);
      if (lowRate >= 1.5 && lowRate <= 25 && highRate > lowRate && highRate <= 35) {
        this._cachedTariff = {
          lowRate: Number(lowRate.toFixed(2)),
          highRate: Number(highRate.toFixed(2)),
          sktRate: Number((Number(raw?.sktRate) || highRate * 1.125).toFixed(2)),
          lowTierLimitKwh: Number(raw?.lowTierLimitKwh) || def.lowTierLimitKwh,
          annualLimitKwh: Number(raw?.annualLimitKwh) || def.annualLimitKwh,
          source: String(raw?.source || def.source),
          updatedAt: raw?.updatedAt || null,
          liveVerified: Boolean(raw?.liveVerified)
        };
      } else {
        this._cachedTariff = { ...def };
      }
    } catch (e) {
      this._cachedTariff = { ...def };
    }
  }

  _saveCachedTariff(tariff) {
    try {
      const tmp = `${this._tariffFilePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(tariff, null, 2), 'utf8');
      fs.renameSync(tmp, this._tariffFilePath);
    } catch (e) {}
  }

  getActiveTariff() {
    if (!this._cachedTariff) {
      this._loadCachedTariff();
    }
    return this._cachedTariff;
  }

  _fetchHttpsText(urlStr, timeoutMs = 4500, redirectsLeft = 2) {
    return new Promise((resolve) => {
      try {
        const req = https.get(
          urlStr,
          {
            timeout: timeoutMs,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) maziPanel/1.0',
              Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
              'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8'
            }
          },
          (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location &&
              redirectsLeft > 0
            ) {
              res.resume();
              const nextUrl = new URL(res.headers.location, urlStr).toString();
              this._fetchHttpsText(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve);
              return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              res.resume();
              resolve(null);
              return;
            }
            const chunks = [];
            let totalLen = 0;
            res.on('data', (chunk) => {
              totalLen += chunk.length;
              if (totalLen <= 512 * 1024) {
                chunks.push(chunk);
              }
            });
            res.on('end', () => {
              resolve(Buffer.concat(chunks).toString('utf8'));
            });
          }
        );
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.on('error', () => resolve(null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  _parseTariffFromHtml(html) {
    if (!html || typeof html !== 'string') return null;
    // Strip tags into clean text while keeping spaces
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ');

    // 1. Direct explicit sentence pattern (e.g. Enerji Atlası: "ilk 240 kWh ... 2,59 TL, kalan miktar için ... 3,89 TL birim fiyat")
    const explicitSentenceMatch = text.match(
      /240\s*kWh[\s\S]{1,140}?(\d{1,2}[.,]\d{2,6})\s*(?:TL|₺)[\s\S]{1,140}?(\d{1,2}[.,]\d{2,6})\s*(?:TL|₺)/i
    );
    if (explicitSentenceMatch) {
      const v1 = parseFloat(explicitSentenceMatch[1].replace(',', '.'));
      const v2 = parseFloat(explicitSentenceMatch[2].replace(',', '.'));
      const low = Math.min(v1, v2);
      const high = Math.max(v1, v2);
      if (!isNaN(low) && !isNaN(high) && low >= 1.5 && low <= 12.0 && high / low >= 1.25 && high / low <= 1.75) {
        const lowRounded = Number(low.toFixed(2));
        const highRounded = Number(high.toFixed(2));
        return {
          lowRate: lowRounded,
          highRate: highRounded,
          sktRate: Number((highRounded * 1.125).toFixed(2))
        };
      }
    }

    // 2. Table row extraction for "Elektrik Fiyatı (d+e)" (1 kWh unit rate in Mesken table)
    const tableLowMatch = text.match(/Elektrik\s+Fiyatı\s*\(d\+e\)\s*(\d{1,2}[.,]\d{2,6})\s*(?:TL|₺)/i);
    if (tableLowMatch) {
      const low = parseFloat(tableLowMatch[1].replace(',', '.'));
      if (!isNaN(low) && low >= 1.5 && low <= 12.0) {
        const lowRounded = Number(low.toFixed(2));
        const highRounded = Number((low * 1.5).toFixed(2));
        return {
          lowRate: lowRounded,
          highRate: highRounded,
          sktRate: Number((highRounded * 1.125).toFixed(2))
        };
      }
    }

    // 3. Fallback: Look for explicit "TL/kWh" or "TL / kWh" unit prices near Mesken keywords (avoids 240 kWh total columns like 5,93 TL BTV)
    const candidates = [];
    const rateRegex = /(\d{1,2}[.,]\d{2,6})\s*(?:TL|₺)\s*\/\s*kWh/gi;
    let m;
    while ((m = rateRegex.exec(text)) !== null) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (!isNaN(val) && val >= 1.5 && val <= 15.0) {
        candidates.push({ val, index: m.index });
      }
    }

    const keywords = ['mesken', 'konut', 'düşük kademe', 'yüksek kademe', '240 kwh', '8 kwh'];
    const lowerText = text.toLowerCase();

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < Math.min(i + 6, candidates.length); j++) {
        const a = candidates[i].val;
        const b = candidates[j].val;
        const low = Math.min(a, b);
        const high = Math.max(a, b);
        const ratio = high / low;
        if (low >= 1.5 && low <= 12.0 && ratio >= 1.25 && ratio <= 1.75) {
          const windowStart = Math.max(0, candidates[i].index - 350);
          const windowEnd = Math.min(lowerText.length, candidates[j].index + 350);
          const snippet = lowerText.slice(windowStart, windowEnd);
          if (keywords.some((kw) => snippet.includes(kw))) {
            const lowRounded = Number(low.toFixed(2));
            const highRounded = Number(high.toFixed(2));
            const sktRounded = Number((highRounded * 1.125).toFixed(2));
            return {
              lowRate: lowRounded,
              highRate: highRounded,
              sktRate: sktRounded
            };
          }
        }
      }
    }
    return null;
  }

  async refreshEpdkTariffAsync(force = false) {
    const active = this.getActiveTariff();
    if (
      !force &&
      active &&
      active.updatedAt &&
      Date.now() - new Date(active.updatedAt).getTime() < 6 * 60 * 60 * 1000
    ) {
      return active;
    }

    if (this._tariffRefreshInProgress) {
      return active;
    }
    this._tariffRefreshInProgress = true;

    try {
      const urls = [
        'https://www.enerjiatlasi.com/elektrik-fiyatlari/',
        'https://www.epdk.gov.tr/Detay/Icerik/3-0-1/tarifeler'
      ];

      let parsedRates = null;

      for (const u of urls) {
        const html = await this._fetchHttpsText(u, 4500);
        if (html) {
          const extracted = this._parseTariffFromHtml(html);
          if (extracted) {
            parsedRates = extracted;
            break;
          }
        }
      }

      const def = this._getDefaultTariff();
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

      const nextTariff = {
        lowRate: parsedRates ? parsedRates.lowRate : active.lowRate || def.lowRate,
        highRate: parsedRates ? parsedRates.highRate : active.highRate || def.highRate,
        sktRate: parsedRates ? parsedRates.sktRate : active.sktRate || def.sktRate,
        lowTierLimitKwh: active.lowTierLimitKwh || def.lowTierLimitKwh,
        annualLimitKwh: active.annualLimitKwh || def.annualLimitKwh,
        source: parsedRates
          ? `EPDK Güncel Mesken (${dateStr})`
          : active.source || def.source,
        updatedAt: now.toISOString(),
        liveVerified: Boolean(parsedRates)
      };

      this._cachedTariff = nextTariff;
      this._saveCachedTariff(nextTariff);
      return nextTariff;
    } finally {
      this._tariffRefreshInProgress = false;
    }
  }

  getPowerMetrics() {
    const mem = this._getHostMemory();
    const instantWatts = this._calculateInstantWatts(this._cpuUsage, mem.usedMem, mem.totalMem);

    let totalSamples = 0;
    let earliestStart = null;

    for (const b of this._hourlyBuckets) {
      totalSamples += b.sampleCount;
      if (!earliestStart || new Date(b.start) < new Date(earliestStart)) {
        earliestStart = b.start;
      }
    }
    if (this._currentMinute && this._currentMinute.sampleCount > 0) {
      totalSamples += this._currentMinute.sampleCount;
      if (!earliestStart || new Date(this._currentMinute.start) < new Date(earliestStart)) {
        earliestStart = this._currentMinute.start;
      }
    }

    const hoursCollected = Number((totalSamples / 360).toFixed(1));
    const requiredHours = (config.ENERGY && config.ENERGY.MIN_HOURS_FOR_ESTIMATE) || 24;
    const progressPct = Math.min(100, Number(((hoursCollected / requiredHours) * 100).toFixed(1)));

    const activeTariff = this.getActiveTariff();

    const tariffResponse = {
      lowRate: activeTariff.lowRate,
      highRate: activeTariff.highRate,
      sktRate: activeTariff.sktRate,
      lowTierLimitKwh: activeTariff.lowTierLimitKwh,
      annualLimitKwh: activeTariff.annualLimitKwh,
      source: activeTariff.source || 'EPDK Güncel Mesken Tarifesi',
      updatedAt: activeTariff.updatedAt || null,
      liveVerified: Boolean(activeTariff.liveVerified)
    };

    const collection = {
      hoursCollected,
      requiredHours,
      progressPct,
      sampleCount: totalSamples,
      since: earliestStart
    };

    const estimateReady = hoursCollected >= requiredHours;

    if (!estimateReady) {
      return {
        watts: instantWatts,
        estimateReady: false,
        collection,
        avgWatts: null,
        idleAvgWatts: null,
        activeAvgWatts: null,
        activeTimePct: null,
        avgPlayers: null,
        kwhPerDay: null,
        kwhPerMonth: null,
        kwhPerYear: null,
        dailyCostTL: null,
        monthlyCostTL: null,
        yearlyCostTL: null,
        effectiveRateTL: null,
        tier: null,
        exceedsAnnualLimit: false,
        tariff: tariffResponse
      };
    }

    const cutoff30d = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let sampleCount30d = 0;
    let wattSum30d = 0;
    let idleSamples30d = 0;
    let idleWattSum30d = 0;
    let activeSamples30d = 0;
    let activeWattSum30d = 0;
    let playerWeightedSum30d = 0;

    for (const b of this._hourlyBuckets) {
      if (new Date(b.start).getTime() >= cutoff30d) {
        sampleCount30d += b.sampleCount;
        wattSum30d += ((b.idleWattSum || 0) + (b.activeWattSum || 0));
        idleSamples30d += b.idleSamples;
        idleWattSum30d += (b.idleWattSum || 0);
        activeSamples30d += b.activeSamples;
        activeWattSum30d += (b.activeWattSum || 0);
        playerWeightedSum30d += ((b.avgPlayers || 0) * b.sampleCount);
      }
    }

    if (this._currentMinute && this._currentMinute.sampleCount > 0) {
      sampleCount30d += this._currentMinute.sampleCount;
      wattSum30d += this._currentMinute.wattSum;
      idleSamples30d += this._currentMinute.idleSamples;
      idleWattSum30d += this._currentMinute.idleWattSum;
      activeSamples30d += this._currentMinute.activeSamples;
      activeWattSum30d += this._currentMinute.activeWattSum;
      playerWeightedSum30d += this._currentMinute.playerSum;
    }

    const avgWatts = sampleCount30d > 0 ? Number((wattSum30d / sampleCount30d).toFixed(2)) : 0;
    const idleAvgWatts = idleSamples30d > 0 ? Number((idleWattSum30d / idleSamples30d).toFixed(2)) : null;
    const activeAvgWatts = activeSamples30d > 0 ? Number((activeWattSum30d / activeSamples30d).toFixed(2)) : null;
    const activeTimePct = sampleCount30d > 0 ? Number(((activeSamples30d / sampleCount30d) * 100).toFixed(1)) : null;
    const avgPlayers = sampleCount30d > 0 ? Number((playerWeightedSum30d / sampleCount30d).toFixed(2)) : null;

    const kwhPerDay = Number(((avgWatts * 24) / 1000).toFixed(2));
    const kwhPerMonth = Number(((avgWatts * 730) / 1000).toFixed(2));
    const kwhPerYear = Number((kwhPerMonth * 12).toFixed(2));

    let tier = null;
    let exceedsAnnualLimit = false;
    let monthlyCostTL = 0;

    if (kwhPerYear > activeTariff.annualLimitKwh) {
      exceedsAnnualLimit = true;
      tier = 'sktt';
      monthlyCostTL = kwhPerMonth * activeTariff.sktRate;
    } else {
      exceedsAnnualLimit = false;
      if (kwhPerMonth <= activeTariff.lowTierLimitKwh) {
        tier = 'low';
        monthlyCostTL = kwhPerMonth * activeTariff.lowRate;
      } else {
        tier = 'high';
        monthlyCostTL = (activeTariff.lowTierLimitKwh * activeTariff.lowRate) +
          ((kwhPerMonth - activeTariff.lowTierLimitKwh) * activeTariff.highRate);
      }
    }

    const effectiveRateTL = kwhPerMonth > 0 ? Number((monthlyCostTL / kwhPerMonth).toFixed(2)) : activeTariff.lowRate;
    const dailyCostTL = Number((monthlyCostTL / 30.42).toFixed(2));
    const yearlyCostTL = Number((monthlyCostTL * 12).toFixed(2));
    const finalMonthlyCostTL = Number(monthlyCostTL.toFixed(2));

    return {
      watts: instantWatts,
      estimateReady: true,
      collection,
      avgWatts,
      idleAvgWatts,
      activeAvgWatts,
      activeTimePct,
      avgPlayers,
      kwhPerDay,
      kwhPerMonth,
      kwhPerYear,
      dailyCostTL,
      monthlyCostTL: finalMonthlyCostTL,
      yearlyCostTL,
      effectiveRateTL,
      tier,
      exceedsAnnualLimit,
      tariff: tariffResponse
    };
  }

  _refreshDiskMetricsAsync() {
    if (this._diskCheckInProgress) return;
    this._diskCheckInProgress = true;

    try {
      const targetDir = fs.existsSync('/mazideveloper')
        ? '/mazideveloper'
        : (fs.existsSync(config.BASE_DIR) ? config.BASE_DIR : '/');

      execFile('df', ['-k', targetDir], {
        encoding: 'utf8',
        timeout: 5000,
        shell: false
      }, (err, stdout) => {
        this._diskCheckInProgress = false;
        this._lastDiskCheck = Date.now();
        if (err || !stdout) return;

        try {
          const lines = stdout.trim().split('\n');
          if (lines.length >= 2) {
            const parts = lines[lines.length - 1].trim().split(/\s+/);
            if (parts.length >= 6) {
              const totalKb = parseInt(parts[1], 10);
              const usedKb = parseInt(parts[2], 10);
              const freeKb = parseInt(parts[3], 10);
              const pct = parseInt(parts[4].replace('%', ''), 10);
              const mount = parts[5] || targetDir;
              if (!isNaN(totalKb) && !isNaN(usedKb) && !isNaN(freeKb)) {
                this._cachedDiskMetrics = {
                  totalBytes: totalKb * 1024,
                  usedBytes: usedKb * 1024,
                  freeBytes: freeKb * 1024,
                  usagePct: isNaN(pct) ? 0 : pct,
                  mount,
                  totalGB: (totalKb / (1024 * 1024)).toFixed(1),
                  usedGB: (usedKb / (1024 * 1024)).toFixed(1),
                  freeGB: (freeKb / (1024 * 1024)).toFixed(1)
                };
              }
            }
          }
        } catch (e) {}
      });
    } catch (e) {
      this._diskCheckInProgress = false;
    }
  }

  _getDiskMetrics() {
    const now = Date.now();
    if (now - this._lastDiskCheck > 30000) {
      this._refreshDiskMetricsAsync();
    }
    return this._cachedDiskMetrics;
  }

  _getNetworkMetrics() {
    const netDir = '/sys/class/net';
    if (!fs.existsSync(netDir)) {
      return {
        interface: null,
        speedMbps: null,
        duplex: null,
        status: null
      };
    }

    try {
      const ifaces = fs.readdirSync(netDir).filter((i) => i !== 'lo');
      let chosenIface = null;
      let chosenStatus = null;

      for (const iface of ifaces) {
        const statePath = path.join(netDir, iface, 'operstate');
        let state = 'unknown';
        if (fs.existsSync(statePath)) {
          try {
            state = fs.readFileSync(statePath, 'utf8').trim();
          } catch (e) {}
        }
        if (state === 'up') {
          chosenIface = iface;
          chosenStatus = state;
          break;
        }
      }

      if (!chosenIface && ifaces.length > 0) {
        chosenIface = ifaces[0];
        const statePath = path.join(netDir, chosenIface, 'operstate');
        if (fs.existsSync(statePath)) {
          try {
            chosenStatus = fs.readFileSync(statePath, 'utf8').trim();
          } catch (e) {}
        } else {
          chosenStatus = 'unknown';
        }
      }

      if (!chosenIface) {
        return {
          interface: null,
          speedMbps: null,
          duplex: null,
          status: null
        };
      }

      let speedMbps = null;
      const speedPath = path.join(netDir, chosenIface, 'speed');
      if (fs.existsSync(speedPath)) {
        try {
          const val = parseInt(fs.readFileSync(speedPath, 'utf8').trim(), 10);
          if (!isNaN(val) && val > 0) {
            speedMbps = val;
          }
        } catch (e) {}
      }

      let duplex = null;
      const duplexPath = path.join(netDir, chosenIface, 'duplex');
      if (fs.existsSync(duplexPath)) {
        try {
          const val = fs.readFileSync(duplexPath, 'utf8').trim();
          if (val) duplex = val;
        } catch (e) {}
      }

      let speedFormatted = null;
      if (speedMbps) {
        speedFormatted = speedMbps >= 1000 ? `${speedMbps / 1000} Gbps` : `${speedMbps} Mbps`;
      }

      return {
        interface: chosenIface,
        speedMbps,
        speed: speedFormatted,
        duplex,
        status: chosenStatus
      };
    } catch (e) {
      return {
        interface: null,
        speedMbps: null,
        duplex: null,
        status: null
      };
    }
  }

  _initSoftwareCache() {
    this._cachedSsh = this._detectSsh();
    this._cachedSystemd = this._detectSystemd();
  }

  _detectSsh() {
    try {
      const res = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 3000, shell: false });
      const out = ((res.stdout || '') + (res.stderr || '')).trim();
      const m = out.match(/^([^\s,]+)/);
      const ver = m ? m[1] : (out.split(',')[0] || out).trim();
      return {
        name: 'OpenSSH',
        version: ver || null,
        status: ver ? 'active' : 'missing',
        role: 'Güvenli Uzak Bağlantı (SSH Servisi)'
      };
    } catch (e) {
      return {
        name: 'OpenSSH',
        version: null,
        status: 'missing',
        role: 'Güvenli Uzak Bağlantı (SSH Servisi)'
      };
    }
  }

  _detectSystemd() {
    try {
      const res = spawnSync('systemctl', ['--version'], { encoding: 'utf8', timeout: 3000, shell: false });
      const out = ((res.stdout || '') + (res.stderr || '')).trim();
      const firstLine = out.split('\n')[0].trim();
      return {
        name: 'systemd',
        version: firstLine || null,
        status: firstLine ? 'active' : 'missing',
        role: 'Servis ve Sistem Yöneticisi'
      };
    } catch (e) {
      return {
        name: 'systemd',
        version: null,
        status: 'missing',
        role: 'Servis ve Sistem Yöneticisi'
      };
    }
  }

  _getJavaSoftware() {
    try {
      const javas = javaDetector.detectJavaInstallations();
      if (!javas || javas.length === 0) {
        return [{
          name: 'Java Runtime',
          version: null,
          status: 'missing',
          role: 'Minecraft JVM Çalıştırıcı'
        }];
      }
      return javas.map((j) => ({
        name: `Java Runtime ${j.majorVersion || j.rawVersion}`,
        version: `${j.vendor} ${j.rawVersion}`,
        status: 'active',
        role: (j.majorVersion && j.majorVersion >= 25)
          ? 'Yeni Nesil Minecraft JVM Çalıştırıcı'
          : 'Minecraft Purpur ve Paper JVM Çalıştırıcı'
      }));
    } catch (e) {
      return [{
        name: 'Java Runtime',
        version: null,
        status: 'missing',
        role: 'Minecraft JVM Çalıştırıcı'
      }];
    }
  }

  _detectP2PTunnel() {
    const now = Date.now();
    if (this._cachedP2P && (now - (this._lastP2PCheck || 0) < 5000)) {
      return this._cachedP2P;
    }
    this._lastP2PCheck = now;

    try {
      const p2pService = require('../p2p/p2pService');
      const state = p2pService.getServiceStateSync();
      const { configPath } = p2pService.readLocalConfig();
      const hasInstall = Boolean(
        state === 'active' ||
        state === 'inactive' ||
        state === 'activating' ||
        state === 'failed' ||
        (configPath && fs.existsSync(configPath)) ||
        fs.existsSync('/etc/systemd/system/p2ptunnel.service') ||
        fs.existsSync('/home/mazidev/p2ptunnel')
      );

      const status = state === 'active'
        ? 'active'
        : (hasInstall ? 'inactive' : 'missing');

      this._cachedP2P = {
        name: 'P2P Tunnel (p2ptunnel.service)',
        version: state === 'active' ? 'Çevrimiçi (UDP 25566 / Web 9090)' : (hasInstall ? `Durum: ${state}` : null),
        status,
        role: 'KCP/UDP Şifreli P2P Oyun Tüneli Servisi'
      };
      return this._cachedP2P;
    } catch (e) {
      this._cachedP2P = {
        name: 'P2P Tunnel (p2ptunnel.service)',
        version: null,
        status: 'missing',
        role: 'KCP/UDP Şifreli P2P Oyun Tüneli Servisi'
      };
      return this._cachedP2P;
    }
  }

  getSoftwareStack() {
    return [
      {
        name: 'Node.js',
        version: process.version,
        status: 'active',
        role: 'maziPanel Backend ve WebSocket Motoru'
      },
      ...this._getJavaSoftware(),
      this._detectP2PTunnel(),
      this._cachedSsh || this._detectSsh(),
      this._cachedSystemd || this._detectSystemd()
    ];
  }

  getHostMetrics() {
    const mem = this._getHostMemory();
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'AMD Ryzen 5 5500';
    const cpuThreads = cpus.length || 12;

    let osPrettyName = 'Debian GNU/Linux';
    if (fs.existsSync('/etc/os-release')) {
      try {
        const osRel = fs.readFileSync('/etc/os-release', 'utf8');
        const match = osRel.match(/PRETTY_NAME="([^"]+)"/);
        if (match) osPrettyName = match[1];
      } catch (e) {}
    }

    const disk = this._getDiskMetrics();
    const network = this._getNetworkMetrics();
    const power = this.getPowerMetrics();
    const software = this.getSoftwareStack();

    return {
      cpu: {
        usagePercent: this._cpuUsage,
        model: cpuModel,
        cores: cpuThreads,
        threads: cpuThreads,
        loadAverage: os.loadavg()
      },
      memory: {
        totalBytes: mem.totalMem,
        usedBytes: mem.usedMem,
        freeBytes: mem.availableMem,
        usagePercent: mem.memUsagePct,
        totalGB: (mem.totalMem / (1024 * 1024 * 1024)).toFixed(2),
        usedGB: (mem.usedMem / (1024 * 1024 * 1024)).toFixed(2),
        freeGB: (mem.availableMem / (1024 * 1024 * 1024)).toFixed(2)
      },
      disk,
      network,
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        osName: osPrettyName,
        uptimeSeconds: os.uptime(),
        daemonUptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version
      },
      software,
      power,
      timestamp: new Date().toISOString()
    };
  }

  getServerMetrics(serverId) {
    const status = processManager.getStatus(serverId);
    if (status.status === 'offline' || !status.pid) {
      return {
        serverId,
        status: status.status,
        running: false,
        pid: null,
        cpuPercent: 0,
        memoryBytes: 0,
        memoryMB: 0,
        allocatedMB: status.allocatedMB || 2048,
        allocatedFormatted: status.allocatedFormatted || '2 GB',
        uptimeSeconds: 0,
        onlinePlayers: []
      };
    }

    const pid = status.pid;
    let cpuPercent = 0;
    let memoryBytes = status.memoryBytes || 0;

    const procStatPath = `/proc/${pid}/stat`;
    const procStatusPath = `/proc/${pid}/status`;

    if (fs.existsSync(procStatPath) && fs.existsSync(procStatusPath)) {
      try {
        if (!memoryBytes) {
          const statusContent = fs.readFileSync(procStatusPath, 'utf8');
          const vmrssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/);
          if (vmrssMatch) {
            memoryBytes = parseInt(vmrssMatch[1], 10) * 1024;
          }
        }

        const statContent = fs.readFileSync(procStatPath, 'utf8');
        const statParts = statContent.split(') ')[1].split(' ');
        const utime = parseInt(statParts[11], 10);
        const stime = parseInt(statParts[12], 10);
        const now = Date.now();

        const prev = this._prevPidTimes.get(pid);
        if (prev) {
          const timeDelta = (now - prev.timestamp) / 1000;
          const clockTicksPerSec = 100;
          const procTicks = (utime + stime) - (prev.utime + prev.stime);
          if (timeDelta > 0 && procTicks >= 0) {
            cpuPercent = Math.min(100 * os.cpus().length, Math.round(((procTicks / clockTicksPerSec) / timeDelta) * 1000) / 10);
          }
        }
        this._prevPidTimes.set(pid, { utime, stime, timestamp: now });
      } catch (e) {
        // Process might have terminated
      }
    }

    return {
      serverId,
      status: status.status,
      running: true,
      pid,
      cpuPercent,
      memoryBytes,
      memoryMB: Math.round(memoryBytes / (1024 * 1024)),
      allocatedMB: status.allocatedMB || 2048,
      allocatedFormatted: status.allocatedFormatted || '2 GB',
      uptimeSeconds: status.uptime,
      onlinePlayers: status.onlinePlayers || []
    };
  }

  getEnergyHistory(range = '24h') {
    let cutoff = 0;
    const now = Date.now();
    const cleanRange = String(range || '24h').toLowerCase();
    if (cleanRange === '24h') {
      cutoff = now - (24 * 60 * 60 * 1000);
    } else if (cleanRange === '7d') {
      cutoff = now - (7 * 24 * 60 * 60 * 1000);
    } else if (cleanRange === '30d') {
      cutoff = now - (30 * 24 * 60 * 60 * 1000);
    } // 'all' -> cutoff = 0

    const currentBuckets = this._hourlyBuckets
      .filter((b) => !cutoff || (new Date(b.start).getTime() >= cutoff))
      .map((b) => {
        const hours = b.sampleCount > 0 ? (b.sampleCount / 360) : 1;
        const kwh = Number(((b.avgWatts * hours) / 1000).toFixed(4));
        return {
          start: b.start,
          avgWatts: b.avgWatts,
          kwh,
          avgPlayers: b.avgPlayers,
          avgCpu: b.avgCpu
        };
      });

    // Load archives list
    const archives = this.listArchives();

    return {
      buckets: currentBuckets,
      archives
    };
  }

  listArchives() {
    if (!fs.existsSync(this._archiveDir)) return [];
    try {
      const files = fs.readdirSync(this._archiveDir).filter((f) => f.endsWith('.json'));
      const archives = [];
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(this._archiveDir, f), 'utf8');
          const data = JSON.parse(content);
          if (data && data.summary) {
            archives.push(data.summary);
          }
        } catch (e) {}
      }
      archives.sort((a, b) => new Date(b.to || b.from || 0).getTime() - new Date(a.to || a.from || 0).getTime());
      return archives;
    } catch (e) {
      return [];
    }
  }

  resetEnergyData() {
    this.flushAndSaveStats();

    const id = `arch-${Date.now()}`;
    const bucketsToArchive = [...this._hourlyBuckets];

    let totalSamples = 0;
    let totalWattSum = 0;
    let earliest = null;
    let latest = null;

    for (const b of bucketsToArchive) {
      totalSamples += b.sampleCount;
      totalWattSum += (b._wattSum || (b.avgWatts * b.sampleCount));
      if (!earliest || new Date(b.start) < new Date(earliest)) earliest = b.start;
      if (!latest || new Date(b.start) > new Date(latest)) latest = b.start;
    }

    const hours = totalSamples > 0 ? Number((totalSamples / 360).toFixed(2)) : 0;
    const avgWatts = totalSamples > 0 ? Number((totalWattSum / totalSamples).toFixed(2)) : 0;
    const totalKwh = Number(((avgWatts * hours) / 1000).toFixed(4));

    const activeTariff = this.getActiveTariff();
    const costTL = Number((totalKwh * activeTariff.lowRate).toFixed(2));

    const nowIso = new Date().toISOString();
    const summary = {
      id,
      from: earliest || nowIso,
      to: latest || nowIso,
      totalKwh,
      avgWatts,
      costTL,
      hours
    };

    const cleanBuckets = bucketsToArchive.map((b) => {
      const bHours = b.sampleCount > 0 ? (b.sampleCount / 360) : 1;
      const kwh = Number(((b.avgWatts * bHours) / 1000).toFixed(4));
      return {
        start: b.start,
        avgWatts: b.avgWatts,
        kwh,
        avgPlayers: b.avgPlayers,
        avgCpu: b.avgCpu
      };
    });

    if (!fs.existsSync(this._archiveDir)) {
      fs.mkdirSync(this._archiveDir, { recursive: true });
    }

    const archivePath = path.join(this._archiveDir, `${id}.json`);
    const tempArchivePath = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempArchivePath, JSON.stringify({ summary, buckets: cleanBuckets }, null, 2), 'utf8');
    fs.renameSync(tempArchivePath, archivePath);

    // Reset current collection
    this._hourlyBuckets = [];
    this._currentMinute = null;
    this._saveEnergyStats();

    return {
      success: true,
      archiveId: id
    };
  }

  getArchive(id) {
    if (!id || !/^[\w-]+$/.test(id)) {
      throw new Error('Geçersiz arşiv kimliği.');
    }
    const archivePath = path.join(this._archiveDir, `${id}.json`);
    if (!fs.existsSync(archivePath)) {
      throw new Error('Arşiv bulunamadı.');
    }
    const content = fs.readFileSync(archivePath, 'utf8');
    return JSON.parse(content);
  }

  deleteArchive(id) {
    if (!id || !/^[\w-]+$/.test(id)) {
      throw new Error('Geçersiz arşiv kimliği.');
    }
    const archivePath = path.join(this._archiveDir, `${id}.json`);
    if (!fs.existsSync(archivePath)) {
      throw new Error('Arşiv bulunamadı.');
    }
    fs.unlinkSync(archivePath);
    return { success: true, message: 'Arşiv başarıyla silindi.' };
  }
}

module.exports = new MetricsService();
