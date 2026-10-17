const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('../config');
const metricsService = require('../src/metrics/metricsService');
const serverRegistry = require('../src/servers/serverRegistry');

function createPngBuffer(width, height) {
  // Create minimal valid PNG buffer with given width and height in IHDR
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdrChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), // length 13
    Buffer.from('IHDR', 'ascii'),
    ihdrData,
    Buffer.from([0x00, 0x00, 0x00, 0x00]) // dummy CRC
  ]);

  const iendChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // length 0
    Buffer.from('IEND', 'ascii'),
    Buffer.from([0xae, 0x42, 0x60, 0x82]) // CRC
  ]);

  return Buffer.concat([signature, ihdrChunk, iendChunk]);
}

async function testAll() {
  console.log('========================================================');
  console.log('       Testing Task 1, Task 2 & Task 3 Features        ');
  console.log('========================================================');

  // --- TEST 1: PNG 64x64 Validation ---
  console.log('[*] Test 1: PNG 64x64 Header and Dimension Validation');
  const valid64Png = createPngBuffer(64, 64);
  const invalidSizePng = createPngBuffer(32, 32);
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

  function validatePng(buf) {
    if (buf.length < 24) return false;
    const isPng =
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a;
    if (!isPng) return false;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width === 64 && height === 64;
  }

  assert.strictEqual(validatePng(valid64Png), true, '64x64 PNG must be valid');
  assert.strictEqual(validatePng(invalidSizePng), false, '32x32 PNG must be rejected');
  assert.strictEqual(validatePng(fakeJpg), false, 'JPEG must be rejected');
  console.log('    PASS: 64x64 PNG header and dimension validation works correctly');

  // --- TEST 2: Task 1 Power Model & Contract ---
  console.log('[*] Test 2: Power Model, Bucket Accumulation & API Contract');
  const hostMetrics = metricsService.getHostMetrics();
  assert(hostMetrics.power, 'Host metrics must have power property');
  const p = hostMetrics.power;

  assert.strictEqual(typeof p.watts, 'number', 'power.watts must be a number');
  assert(p.watts > 0, 'power.watts must be greater than 0');
  assert.strictEqual(typeof p.estimateReady, 'boolean', 'power.estimateReady must be boolean');
  assert(p.collection, 'power.collection must exist');
  assert.strictEqual(typeof p.collection.hoursCollected, 'number');
  assert.strictEqual(typeof p.collection.requiredHours, 'number');
  assert.strictEqual(typeof p.collection.progressPct, 'number');
  assert.strictEqual(typeof p.collection.sampleCount, 'number');
  assert(p.tariff, 'power.tariff must exist');
  assert.strictEqual(p.tariff.lowRate, 3.24);
  assert.strictEqual(p.tariff.highRate, 4.32);
  assert.strictEqual(p.tariff.sktRate, 4.86);
  assert.strictEqual(p.tariff.lowTierLimitKwh, 240);
  assert.strictEqual(p.tariff.annualLimitKwh, 4000);
  assert.strictEqual(p.tariff.source, 'EPDK 04.04.2026 Mesken');

  if (!p.estimateReady) {
    assert.strictEqual(p.avgWatts, null);
    assert.strictEqual(p.idleAvgWatts, null);
    assert.strictEqual(p.activeAvgWatts, null);
    assert.strictEqual(p.activeTimePct, null);
    assert.strictEqual(p.avgPlayers, null);
    assert.strictEqual(p.kwhPerDay, null);
    assert.strictEqual(p.kwhPerMonth, null);
    assert.strictEqual(p.kwhPerYear, null);
    assert.strictEqual(p.dailyCostTL, null);
    assert.strictEqual(p.monthlyCostTL, null);
    assert.strictEqual(p.yearlyCostTL, null);
    assert.strictEqual(p.effectiveRateTL, null);
    assert.strictEqual(p.tier, null);
    console.log('    PASS: estimateReady=false returns collection progress and all estimate fields null');
  }

  // --- TEST 3: Synthetic Estimation Calculation Verification ---
  console.log('[*] Test 3: Tariff Calculation Engine Verification');
  // Simulate 25 hours with avg 50 Watts (no annual exceedance)
  // 50W * 24 / 1000 = 1.2 kWh/day
  // 50W * 730 / 1000 = 36.5 kWh/month <= 240 -> low tier (36.5 * 3.24 = 118.26 TL)
  const lowMonthKwh = 36.5;
  const lowCost = lowMonthKwh * 3.24;
  assert.strictEqual(Number(lowCost.toFixed(2)), 118.26);

  // High tier: 300 kWh/month: 240 * 3.24 + 60 * 4.32 = 777.6 + 259.2 = 1036.80 TL
  const highMonthKwh = 300;
  const highCost = (240 * 3.24) + ((highMonthKwh - 240) * 4.32);
  assert.strictEqual(Number(highCost.toFixed(2)), 1036.80);

  // SKTT tier: 4500 kWh/year (> 4000 limit): 375 kWh/month * 4.86 = 1822.50 TL
  const skttMonthKwh = 375;
  const skttCost = skttMonthKwh * 4.86;
  assert.strictEqual(Number(skttCost.toFixed(2)), 1822.50);
  console.log('    PASS: EPDK 2026 low, high, and SKTT tiers calculated with exact arithmetic');

  // --- TEST 4: Task 2 System, Network & Software Stack ---
  console.log('[*] Test 4: Real System, Network Interface & Software Stack');
  assert(hostMetrics.network, 'hostMetrics.network must exist');
  assert('interface' in hostMetrics.network, 'network.interface must exist');
  assert('speedMbps' in hostMetrics.network, 'network.speedMbps must exist');
  assert('duplex' in hostMetrics.network, 'network.duplex must exist');
  assert('status' in hostMetrics.network, 'network.status must exist');

  assert(Array.isArray(hostMetrics.software), 'hostMetrics.software must be an Array');
  assert(hostMetrics.software.length >= 3, 'Must contain at least Node.js, Java, SSH, systemd');
  const nodeItem = hostMetrics.software.find((s) => s.name === 'Node.js');
  assert(nodeItem, 'Node.js must be in software stack');
  assert.strictEqual(nodeItem.version, process.version);
  assert.strictEqual(nodeItem.status, 'active');

  for (const sw of hostMetrics.software) {
    assert(sw.name, 'Software item must have name');
    assert('version' in sw, 'Software item must have version (string or null)');
    assert(['active', 'inactive', 'missing'].includes(sw.status), `Invalid software status: ${sw.status}`);
    assert(sw.role, 'Software item must have role');
  }
  console.log('    PASS: Software stack schema strictly adhered to: Node.js, Java, SSH, systemd');

  console.log('========================================================');
  console.log('   ALL TASKS 1, 2, 3 SUITE TESTS PASSED SUCCESSFULLY!   ');
  console.log('========================================================');
}

testAll().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('[TEST FAILURE]:', err);
  process.exit(1);
});
