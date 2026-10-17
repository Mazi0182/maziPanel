const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { execSync } = require('child_process');

const authService = require('../src/auth/authService');
const serverRegistry = require('../src/servers/serverRegistry');
const processManager = require('../src/servers/processManager');
const config = require('../config');

const PORT = process.env.TEST_PORT || process.env.PORT || '8080';
const HOST = process.env.TEST_HOST || '127.0.0.1';
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;

async function request(urlPath, options = {}) {
  const token = authService.generateToken({ username: 'masteradmin', role: 'admin' });
  const parsedUrl = new URL(urlPath, BASE_URL);
  return new Promise((resolve, reject) => {
    const payload = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          data = raw;
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('   maziPanel Backend Full Feature Verification Suite');
  console.log('====================================================\n');

  // Find or register a test server
  const servers = serverRegistry.getAll();
  const testServer = servers[0];
  if (!testServer) {
    throw new Error('No server found in registry to test.');
  }
  const srvId = testServer.id;
  console.log(`[*] Using test server: ${srvId}`);

  // ---------------------------------------------------------------
  // 1. GET /api/servers & GET /api/servers/:id (Settings & RAM Format)
  // ---------------------------------------------------------------
  console.log('\n[*] 1. Testing GET /api/servers/:id and RAM formatting...');
  const getRes = await request(`/api/servers/${srvId}`);
  assert.strictEqual(getRes.status, 200, `Expected 200, got ${getRes.status}`);
  assert(getRes.data.settings, 'Response must contain settings object');
  assert(getRes.data.settings.memory, 'settings must have memory');
  assert.strictEqual(typeof getRes.data.settings.memory.minMB, 'number');
  assert.strictEqual(typeof getRes.data.settings.memory.maxMB, 'number');
  assert(getRes.data.settings.startup, 'settings must have startup');
  assert(getRes.data.settings.crash, 'settings must have crash');
  assert(getRes.data.settings.stop, 'settings must have stop');
  assert(getRes.data.settings.restart, 'settings must have restart');
  assert(['never', 'always', 'last_state'].includes(getRes.data.settings.autoStartOnBoot));

  // RAM format check: 1GB, 512MB, not 1G
  console.log(`    - ramAllocated: "${getRes.data.ramAllocated}"`);
  console.log(`    - allocatedFormatted: "${getRes.data.allocatedFormatted}"`);
  assert(!/^(\d+)G$/.test(getRes.data.ramAllocated), 'ramAllocated must be "1GB", not "1G"');
  assert(/GB|MB/i.test(getRes.data.ramAllocated), 'ramAllocated must include GB or MB unit');
  console.log('    PASS: Settings object and RAM display formatting verified.');

  // ---------------------------------------------------------------
  // 2. PUT /api/servers/:id/settings (Validation & Deep Merge)
  // ---------------------------------------------------------------
  console.log('\n[*] 2. Testing PUT /api/servers/:id/settings...');
  
  // Validation error: minMB > maxMB
  const invalidRes = await request(`/api/servers/${srvId}/settings`, {
    method: 'PUT',
    body: { memory: { minMB: 8192, maxMB: 2048 } }
  });
  assert.strictEqual(invalidRes.status, 400, 'Expected 400 on invalid memory setting');
  console.log(`    - Validation error message: "${invalidRes.data.error}"`);
  assert(invalidRes.data.error.includes('Minimum bellek'), 'Expected Turkish error message for memory');

  // Valid partial update
  const validRes = await request(`/api/servers/${srvId}/settings`, {
    method: 'PUT',
    body: {
      stop: { timeoutSec: 35 },
      crash: { delaySec: 4 }
    }
  });
  assert.strictEqual(validRes.status, 200, `Expected 200, got ${validRes.status}`);
  const updatedSettings = validRes.data.settings || validRes.data;
  assert.strictEqual(updatedSettings.stop.timeoutSec, 35, 'stop.timeoutSec must be 35');
  assert.strictEqual(updatedSettings.crash.delaySec, 4, 'crash.delaySec must be 4');
  assert.strictEqual(typeof validRes.data.requiresRestart, 'boolean');
  console.log(`    PASS: PUT /settings partial merge & validation working correctly (requiresRestart: ${validRes.data.requiresRestart})`);

  // Restore settings
  await request(`/api/servers/${srvId}/settings`, {
    method: 'PUT',
    body: { stop: { timeoutSec: 30 }, crash: { delaySec: 3 } }
  });

  // ---------------------------------------------------------------
  // 3. GET /api/servers/:id/logs/files & /:id/logs/files/:name
  // ---------------------------------------------------------------
  console.log('\n[*] 3. Testing Old Logs File APIs...');
  const logsDir = path.join(testServer.directory, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Create mock log files: latest.log and archive .log.gz
  fs.writeFileSync(path.join(logsDir, 'latest.log'), '[12:00:00 INFO]: Live log line 1\n[12:00:01 INFO]: Live log line 2\n', 'utf8');
  const gzContent = zlib.gzipSync(Buffer.from('[10:00:00 INFO]: Archived gz log line 1\n[10:00:02 INFO]: Archived gz log line 2\n', 'utf8'));
  fs.writeFileSync(path.join(logsDir, '2026-10-09-1.log.gz'), gzContent);

  const listLogsRes = await request(`/api/servers/${srvId}/logs/files`);
  assert.strictEqual(listLogsRes.status, 200);
  assert(Array.isArray(listLogsRes.data), 'Expected array of log files');
  assert(listLogsRes.data.length >= 2, 'Expected at least 2 log files');
  assert.strictEqual(listLogsRes.data[0].name, 'latest.log', 'latest.log must always be first');
  console.log(`    - Files found: ${listLogsRes.data.map((f) => f.name).join(', ')}`);

  // Read latest.log
  const readLatestRes = await request(`/api/servers/${srvId}/logs/files/latest.log`);
  assert.strictEqual(readLatestRes.status, 200);
  assert(readLatestRes.data.content.includes('Live log line 1'));
  assert.strictEqual(readLatestRes.data.truncated, false);
  console.log('    PASS: latest.log read successfully.');

  // Read gz archive
  const readGzRes = await request(`/api/servers/${srvId}/logs/files/2026-10-09-1.log.gz`);
  assert.strictEqual(readGzRes.status, 200);
  assert(readGzRes.data.content.includes('Archived gz log line 1'));
  assert.strictEqual(readGzRes.data.truncated, false);
  console.log('    PASS: 2026-10-09-1.log.gz decompressed & read successfully.');

  // Path traversal rejection
  const traversalRes = await request(`/api/servers/${srvId}/logs/files/..%2fconfig.js`);
  assert.strictEqual(traversalRes.status, 400, 'Path traversal must be rejected with 400');
  console.log('    PASS: Path traversal attack rejected with HTTP 400.');

  // ---------------------------------------------------------------
  // 4. Energy API: History, Reset, Archives
  // ---------------------------------------------------------------
  console.log('\n[*] 4. Testing Energy Metrics APIs (/api/metrics/energy/*)...');
  
  // History
  const histRes = await request('/api/metrics/energy/history?range=24h');
  assert.strictEqual(histRes.status, 200);
  assert(Array.isArray(histRes.data.buckets), 'buckets must be an array');
  assert(Array.isArray(histRes.data.archives), 'archives must be an array');
  console.log(`    - History returned ${histRes.data.buckets.length} buckets and ${histRes.data.archives.length} archives`);

  // Reset
  const resetRes = await request('/api/metrics/energy/reset', { method: 'POST' });
  assert.strictEqual(resetRes.status, 200);
  assert.strictEqual(resetRes.data.success, true);
  assert(resetRes.data.archiveId, 'archiveId must be returned on reset');
  const archId = resetRes.data.archiveId;
  console.log(`    - Energy reset created archive: ${archId}`);

  // Get Archive
  const getArchRes = await request(`/api/metrics/energy/archives/${archId}`);
  assert.strictEqual(getArchRes.status, 200);
  assert(getArchRes.data.summary, 'Archive must have summary');
  assert(Array.isArray(getArchRes.data.buckets), 'Archive must have buckets');
  console.log(`    - Archive summary: hours=${getArchRes.data.summary.hours}, totalKwh=${getArchRes.data.summary.totalKwh}`);

  // Delete Archive
  const delArchRes = await request(`/api/metrics/energy/archives/${archId}`, { method: 'DELETE' });
  assert.strictEqual(delArchRes.status, 200);
  assert.strictEqual(delArchRes.data.success, true);
  console.log('    PASS: Energy history, reset, get archive, delete archive all verified.');

  // ---------------------------------------------------------------
  // 5. Critical Bug: Console "stop" must NOT auto-restart
  // ---------------------------------------------------------------
  console.log('\n[*] 5. Testing Critical Bug: Console "stop" must NOT trigger auto-restart...');

  const stopTestId = 'stop-test-verify-' + Date.now().toString(36);
  const stopTestDir = path.join(config.TEMP_DIR, stopTestId);
  fs.mkdirSync(stopTestDir, { recursive: true });

  // Create Java mock server
  const javaSrc = [
    'import java.io.BufferedReader;',
    'import java.io.InputStreamReader;',
    'public class MockStopServer {',
    '    public static void main(String[] args) throws Exception {',
    '        System.out.println("[Server thread/INFO]: Done (0.500s)! For help, type \\"help\\"");',
    '        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));',
    '        String line;',
    '        while ((line = in.readLine()) != null) {',
    '            String trimmed = line.trim();',
    '            if (trimmed.equalsIgnoreCase("stop")) {',
    '                System.out.println("[Server thread/INFO]: Stopping server");',
    '                System.exit(0);',
    '            }',
    '        }',
    '    }',
    '}'
  ].join('\n');
  fs.writeFileSync(path.join(stopTestDir, 'MockStopServer.java'), javaSrc, 'utf8');

  const javacPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/javac')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/javac'
    : 'javac';
  const jarPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/jar')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/jar'
    : 'jar';

  execSync(`"${javacPath}" MockStopServer.java`, { cwd: stopTestDir });
  execSync(`"${jarPath}" cfe server.jar MockStopServer MockStopServer.class`, { cwd: stopTestDir });

  // Register with autoRestart: true
  serverRegistry.register({
    id: stopTestId,
    name: 'Console Stop Bug Test',
    directory: stopTestDir,
    jarFile: 'server.jar',
    javaPath: '/usr/lib/jvm/jdk-27-oracle-x64/bin/java',
    minRam: '256M',
    maxRam: '256M',
    autoRestart: true,
    maxCrashRetries: 5
  });

  try {
    console.log('    [*] Starting test server...');
    const startRes = await request(`/api/servers/${stopTestId}/start`, { method: 'POST' });
    assert.strictEqual(startRes.status, 200, 'Server should start');

    // Wait 1.5s for server to become online
    await new Promise((r) => setTimeout(r, 1500));
    const statusBefore = await request(`/api/servers/${stopTestId}`);
    console.log(`    - Status before stop: ${statusBefore.data.runtime.status}`);
    assert.strictEqual(statusBefore.data.runtime.status, 'online', 'Server should be online');

    // Send console command "stop"
    console.log('    [*] Sending console command: "stop"...');
    const cmdRes = await request(`/api/servers/${stopTestId}/command`, {
      method: 'POST',
      body: { command: 'stop' }
    });
    assert.strictEqual(cmdRes.status, 200, 'Command endpoint should succeed');

    // Wait 2 seconds for server process to terminate
    await new Promise((r) => setTimeout(r, 2000));

    const statusAfterExit = await request(`/api/servers/${stopTestId}`);
    console.log(`    - Status immediately after stop exit: ${statusAfterExit.data.runtime.status}`);
    assert.strictEqual(statusAfterExit.data.runtime.status, 'offline', 'Status must be "offline" (NOT "starting" or "crashed")');

    // Wait 5 seconds (auto-restart delay is 3s) to guarantee no resurrection happens!
    console.log('    [*] Waiting 5 seconds to verify server does NOT resurrect...');
    await new Promise((r) => setTimeout(r, 5000));

    const statusAfterDelay = await request(`/api/servers/${stopTestId}`);
    console.log(`    - Status after 5s wait: ${statusAfterDelay.data.runtime.status}`);
    assert.strictEqual(statusAfterDelay.data.runtime.status, 'offline', 'Server MUST REMAIN offline and NOT auto-restart!');

    console.log('    PASS: Console "stop" cleanly stopped the server without auto-restart resurrection!');
  } finally {
    // Cleanup
    try {
      await processManager.stopServer(stopTestId, 1000);
    } catch (e) {}
    serverRegistry.delete(stopTestId);
    if (fs.existsSync(stopTestDir)) {
      fs.rmSync(stopTestDir, { recursive: true, force: true });
    }
  }

  console.log('\n====================================================');
  console.log('   ALL NEW FEATURES VERIFIED & PASSED 100%!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('\n[!] Test Suite Failed:', err);
  process.exit(1);
});
