const http = require('http');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { WebSocket } = require('ws');

const PORT = process.env.TEST_PORT || process.env.PORT || '8080';
const HOST = process.env.TEST_HOST || '127.0.0.1';
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;
const WS_URL = process.env.WS_URL || `ws://${HOST}:${PORT}/ws`;

let authToken = null;
let testServerId = null;

function request(options, bodyData = null, isMultipart = false, boundary = '') {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(options.url, BASE_URL);
    let payload = null;
    if (bodyData) {
      if (Buffer.isBuffer(bodyData)) {
        payload = bodyData;
      } else if (typeof bodyData === 'object' && !isMultipart) {
        payload = Buffer.from(JSON.stringify(bodyData), 'utf8');
      } else {
        payload = Buffer.from(String(bodyData), 'utf8');
      }
    }

    const reqOpts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) }
    };

    if (authToken && !reqOpts.headers['Authorization']) {
      reqOpts.headers['Authorization'] = `Bearer ${authToken}`;
    }

    if (payload) {
      if (!isMultipart && !reqOpts.headers['Content-Type']) {
        reqOpts.headers['Content-Type'] = 'application/json';
      }
      if (!reqOpts.headers['Content-Length']) {
        reqOpts.headers['Content-Length'] = payload.length;
      }
    }

    const req = http.request(reqOpts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = raw;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    });

    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function buildMultipartFormData(fields, fileField) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];

  for (const [key, val] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      )
    );
  }

  if (fileField) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\nContent-Type: application/zip\r\n\r\n`
      )
    );
    parts.push(fileField.buffer);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    boundary,
    buffer: Buffer.concat(parts)
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('       maziPanel Backend Verification Tests         ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function assertTest(name, fn) {
    try {
      process.stdout.write(`[*] Testing: ${name}... `);
      await fn();
      console.log('PASSED');
      passed++;
    } catch (err) {
      console.log('FAILED');
      console.error(`    Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Health check
  await assertTest('Health check endpoint (/api/health)', async () => {
    const res = await request({ url: '/api/health' });
    if (res.status !== 200 || res.data.status !== 'healthy') {
      throw new Error(`Expected healthy status, got ${res.status}: ${JSON.stringify(res.data)}`);
    }
  });

  // 2. Auth status & setup wizard
  await assertTest('Master Admin Setup & Login (/api/auth)', async () => {
    // Check initial status
    const statusRes = await request({ url: '/api/auth/status' });
    if (statusRes.status !== 200) {
      throw new Error(`Status check failed: ${statusRes.status}`);
    }

    if (!statusRes.data.initialized) {
      // Perform setup
      const setupRes = await request({
        url: '/api/auth/setup',
        method: 'POST'
      }, {
        username: 'masteradmin',
        password: 'AdminPassword123!'
      });

      if (setupRes.status !== 201 || !setupRes.data.token) {
        throw new Error(`Setup failed: ${JSON.stringify(setupRes.data)}`);
      }
      authToken = setupRes.data.token;
    } else {
      // Already initialized, test login
      const loginRes = await request({
        url: '/api/auth/login',
        method: 'POST'
      }, {
        username: statusRes.data.username || 'masteradmin',
        password: 'AdminPassword123!'
      });

      if (loginRes.status !== 200 || !loginRes.data.token) {
        // Try fallback if password differed
        throw new Error(`Login failed for ${statusRes.data.username}: ${JSON.stringify(loginRes.data)}`);
      }
      authToken = loginRes.data.token;
    }

    // Verify /api/auth/me
    const meRes = await request({ url: '/api/auth/me' });
    if (meRes.status !== 200 || !meRes.data.user) {
      throw new Error(`Auth me check failed: ${JSON.stringify(meRes.data)}`);
    }
  });

  // 3. Java Detection
  await assertTest('Java Detection (/api/servers/system/java)', async () => {
    const res = await request({ url: '/api/servers/system/java' });
    if (res.status !== 200 || !Array.isArray(res.data)) {
      throw new Error(`Java detection failed: ${JSON.stringify(res.data)}`);
    }
    console.log(`\n    Detected ${res.data.length} Java runtimes:`);
    for (const j of res.data) {
      console.log(`      - Java ${j.majorVersion} (${j.vendor}) at ${j.path}`);
    }
    if (res.data.length === 0) {
      throw new Error('No Java runtime detected!');
    }
  });

  // 4. Host Metrics
  await assertTest('Host Metrics (/api/metrics/host)', async () => {
    const res = await request({ url: '/api/metrics/host' });
    if (res.status !== 200 || !res.data.cpu || !res.data.memory) {
      throw new Error(`Host metrics invalid: ${JSON.stringify(res.data)}`);
    }
    if (!res.data.network || res.data.network.speed !== '1 Gbps') {
      throw new Error(`Expected network speed 1 Gbps, got: ${JSON.stringify(res.data.network)}`);
    }
    console.log(`\n    CPU: ${res.data.cpu.model} (${res.data.cpu.cores} cores)`);
    console.log(`    RAM: ${(res.data.memory.usedBytes / 1024 / 1024 / 1024).toFixed(2)} GB used / ${(res.data.memory.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB total`);
    console.log(`    Disk: ${(res.data.disk.usedBytes / 1024 / 1024 / 1024).toFixed(2)} GB used / ${(res.data.disk.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB total`);
    console.log(`    Network: ${res.data.network.speed} (${res.data.network.speedMbps} Mbps)`);
  });

  // 4b. Endpoint Protection: Internal endpoints require auth; Bootstrap endpoints accessible
  await assertTest('Endpoint Protection: Bootstrap endpoints accessible; Internal endpoints require auth', async () => {
    const oldToken = authToken;
    authToken = null;
    try {
      // 1. Public bootstrap endpoints must be accessible without token
      const healthRes = await request({ url: '/api/health' });
      if (healthRes.status !== 200) {
        throw new Error(`Expected HTTP 200 for unauthenticated /api/health, got ${healthRes.status}`);
      }
      const statusRes = await request({ url: '/api/auth/status' });
      if (statusRes.status !== 200) {
        throw new Error(`Expected HTTP 200 for unauthenticated /api/auth/status, got ${statusRes.status}`);
      }

      // 2. Internal endpoints must be REJECTED with 401 without token
      const metricsRes = await request({ url: '/api/metrics/host' });
      if (metricsRes.status !== 401) {
        throw new Error(`Expected HTTP 401 for unauthenticated /api/metrics/host, got ${metricsRes.status}`);
      }
      const coresRes = await request({ url: '/api/servers/cores/versions?type=purpur' });
      if (coresRes.status !== 401) {
        throw new Error(`Expected HTTP 401 for unauthenticated /api/servers/cores/versions, got ${coresRes.status}`);
      }
      const serversQueryRes = await request({ url: '/api/servers?limit=10' });
      if (serversQueryRes.status !== 401) {
        throw new Error(`Expected HTTP 401 for unauthenticated /api/servers?limit=10, got ${serversQueryRes.status}`);
      }

      // 3. When authenticated, internal endpoints must be ACCEPTED with 200
      authToken = oldToken;
      const authMetricsRes = await request({ url: '/api/metrics/host' });
      if (authMetricsRes.status !== 200) {
        throw new Error(`Expected HTTP 200 for authenticated /api/metrics/host, got ${authMetricsRes.status}`);
      }
      const authCoresRes = await request({ url: '/api/servers/cores/versions?type=purpur' });
      if (authCoresRes.status !== 200) {
        throw new Error(`Expected HTTP 200 for authenticated /api/servers/cores/versions, got ${authCoresRes.status}`);
      }
      const authServersRes = await request({ url: '/api/servers?limit=10' });
      if (authServersRes.status !== 200) {
        throw new Error(`Expected HTTP 200 for authenticated /api/servers?limit=10, got ${authServersRes.status}`);
      }
    } finally {
      authToken = oldToken;
    }
  });

  // 4c. Core Discovery Versions (Purpur, Paper, Vanilla)
  await assertTest('Core Discovery: Purpur, Paper, Vanilla (/api/servers/cores/versions)', async () => {
    // Purpur
    const purpurRes = await request({ url: '/api/servers/cores/versions?type=purpur' });
    if (purpurRes.status !== 200 || !Array.isArray(purpurRes.data.versions) || purpurRes.data.versions.length === 0) {
      throw new Error(`Purpur versions failed: ${JSON.stringify(purpurRes.data)}`);
    }
    console.log(`\n    Purpur: found ${purpurRes.data.versions.length} versions (latest: ${purpurRes.data.versions[0]})`);

    // Paper
    const paperRes = await request({ url: '/api/servers/cores/versions?type=paper' });
    if (paperRes.status !== 200 || !Array.isArray(paperRes.data.versions) || paperRes.data.versions.length === 0) {
      throw new Error(`Paper versions failed: ${JSON.stringify(paperRes.data)}`);
    }
    console.log(`    Paper: found ${paperRes.data.versions.length} versions (latest: ${paperRes.data.versions[0]})`);

    // Vanilla
    const vanillaRes = await request({ url: '/api/servers/cores/versions?type=vanilla' });
    if (vanillaRes.status !== 200 || !Array.isArray(vanillaRes.data.versions) || vanillaRes.data.versions.length === 0) {
      throw new Error(`Vanilla versions failed: ${JSON.stringify(vanillaRes.data)}`);
    }
    console.log(`    Vanilla: found ${vanillaRes.data.versions.length} versions (latest: ${vanillaRes.data.versions[0]})`);
  });

  // 5. ZIP Import
  await assertTest('ZIP Server Import (/api/servers/import-zip)', async () => {
    // Build a mock Minecraft server ZIP
    const zip = new AdmZip();
    // Dummy server.properties
    zip.addFile('server.properties', Buffer.from('server-port=25585\nmotd=maziPanel Test Server\nonline-mode=false\nmax-players=50\n'));
    // Dummy paper.jar
    zip.addFile('paper-test.jar', Buffer.from('PK\x05\x06' + '\x00'.repeat(18))); // minimal valid empty zip as jar
    // Dummy eula.txt
    zip.addFile('eula.txt', Buffer.from('eula=false\n'));
    // Dummy plugins dir
    zip.addFile('plugins/readme.txt', Buffer.from('Plugins folder test'));

    const zipBuffer = zip.toBuffer();
    const multipart = buildMultipartFormData(
      { name: 'test-server' },
      { name: 'file', filename: 'test-server.zip', buffer: zipBuffer }
    );

    const res = await request({
      url: '/api/servers/import-zip',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`
      }
    }, multipart.buffer, true);

    if (res.status !== 201 || !res.data.server) {
      throw new Error(`ZIP import failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    testServerId = res.data.server.id;
    console.log(`\n    Imported server ID: ${testServerId}, jarFile: ${res.data.server.jarFile}, port: ${res.data.server.port}`);

    // Verify eula.txt was set to true
    const eulaContent = fs.readFileSync(path.join(res.data.server.directory, 'eula.txt'), 'utf8');
    if (!eulaContent.includes('eula=true')) {
      throw new Error('eula=true was not automatically configured in imported server!');
    }
  });

  // 6. File Manager
  await assertTest('File Manager (List, Write, Read, Security Check)', async () => {
    if (!testServerId) throw new Error('No test server ID available');

    // List files
    const listRes = await request({ url: `/api/servers/${testServerId}/files` });
    if (listRes.status !== 200 || !Array.isArray(listRes.data.entries)) {
      throw new Error(`List files failed: ${JSON.stringify(listRes.data)}`);
    }

    // Write a new file
    const testContent = 'key: value\narray:\n  - item1\n  - item2\n';
    const writeRes = await request({
      url: `/api/servers/${testServerId}/files/content`,
      method: 'POST'
    }, {
      path: 'config/test.yml',
      content: testContent
    });
    if (writeRes.status !== 200) {
      throw new Error(`Write file failed: ${JSON.stringify(writeRes.data)}`);
    }

    // Read back file
    const readRes = await request({
      url: `/api/servers/${testServerId}/files/content?path=config/test.yml`
    });
    if (readRes.status !== 200 || readRes.data.content !== testContent) {
      throw new Error(`Read file failed or content mismatch: ${JSON.stringify(readRes.data)}`);
    }

    // Test creating file in nested subfolder
    const nestedRes = await request({
      url: `/api/servers/${testServerId}/files/create-file`,
      method: 'POST'
    }, {
      path: 'plugins/custom_dir',
      name: 'config.json',
      content: '{"enabled":true}'
    });
    if (nestedRes.status !== 201) {
      throw new Error(`create-file with nested directory failed: ${JSON.stringify(nestedRes.data)}`);
    }

    // Test deleting file with path in JSON body
    const delBodyRes = await request({
      url: `/api/servers/${testServerId}/files`,
      method: 'DELETE'
    }, {
      path: 'plugins/custom_dir/config.json'
    });
    if (delBodyRes.status !== 200) {
      throw new Error(`DELETE /files with body path failed: ${JSON.stringify(delBodyRes.data)}`);
    }

    // Path traversal security check (must fail with 400)
    const hackRes = await request({
      url: `/api/servers/${testServerId}/files/content?path=../../../../etc/passwd`
    });
    if (hackRes.status === 200) {
      throw new Error('SECURITY VULNERABILITY: Path traversal was not blocked!');
    }
    console.log(`\n    Security Path Traversal Check: Blocked with HTTP ${hackRes.status}`);

    // Symlink traversal check
    const symlinkRes = await request({
      url: `/api/servers/${testServerId}/files/content?path=invalid/../../../../etc/shadow`
    });
    if (symlinkRes.status === 200) {
      throw new Error('SECURITY VULNERABILITY: Nested traversal was not blocked!');
    }
  });

  // 6b. Security: Reject Zip Slip
  await assertTest('Security Check: Reject Zip Slip Archive', async () => {
    const maliciousZip = new AdmZip();
    maliciousZip.addFile('pwned.txt', Buffer.from('pwned'));
    const entries = maliciousZip.getEntries();
    entries[0].entryName = '../../../../tmp/pwned.txt';
    const zipBuffer = maliciousZip.toBuffer();
    const multipart = buildMultipartFormData(
      { name: 'zip-slip-attack' },
      { name: 'file', filename: 'attack.zip', buffer: zipBuffer }
    );

    const res = await request({
      url: '/api/servers/import-zip',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`
      }
    }, multipart.buffer, true);

    if (res.status === 201) {
      throw new Error('SECURITY VULNERABILITY: Zip Slip was not rejected!');
    }
    console.log(`\n    Zip Slip Attack correctly rejected with HTTP ${res.status}`);
  });

  // 6c. Security: Reject Unauthorized Server Directory Confinement
  await assertTest('Security Check: Server Directory Confinement', async () => {
    const res = await request({
      url: '/api/servers',
      method: 'POST'
    }, {
      name: 'Unsafe Directory Test',
      directory: '/etc'
    });

    if (res.status === 201) {
      throw new Error('SECURITY VULNERABILITY: Server registered outside base directory!');
    }
    console.log(`\n    Directory escape registration blocked with HTTP ${res.status}`);
  });

  // 7. Player Management API
  await assertTest('Player Management API (/api/servers/:id/players)', async () => {
    if (!testServerId) throw new Error('No test server ID available');

    const res = await request({ url: `/api/servers/${testServerId}/players` });
    if (res.status !== 200 || !Array.isArray(res.data.online)) {
      throw new Error(`Get players failed: ${JSON.stringify(res.data)}`);
    }

    const listsRes = await request({ url: `/api/servers/${testServerId}/players/lists` });
    if (listsRes.status !== 200 || !listsRes.data.ops) {
      throw new Error(`Get player lists failed: ${JSON.stringify(listsRes.data)}`);
    }

    // Security: Command injection in kick/ban player name must be rejected
    const injectRes = await request({
      url: `/api/servers/${testServerId}/players/kick`,
      method: 'POST'
    }, {
      player: 'steve\nop hacker\nstop\n',
      reason: 'bye'
    });

    if (injectRes.status === 200) {
      throw new Error('SECURITY VULNERABILITY: Newline command injection was not rejected!');
    }
    console.log(`\n    Console Command Injection rejected with HTTP ${injectRes.status}`);

    // Verify kick without reason passes player validation
    const kickNoReasonRes = await request({
      url: `/api/servers/${testServerId}/players/kick`,
      method: 'POST'
    }, {
      player: 'Steve'
    });
    if (kickNoReasonRes.status !== 200 && !(kickNoReasonRes.status === 400 && (kickNoReasonRes.data.error?.includes('is not running') || kickNoReasonRes.data.error?.includes('çalışmıyor')))) {
      throw new Error(`Kick without reason failed: ${JSON.stringify(kickNoReasonRes.data)}`);
    }

    // Verify ban with custom reason succeeds without error or passes validation
    const banWithReasonRes = await request({
      url: `/api/servers/${testServerId}/players/ban`,
      method: 'POST'
    }, {
      player: 'Alex',
      reason: 'Griefing\n op hacker'
    });
    if (banWithReasonRes.status !== 200 && !(banWithReasonRes.status === 400 && (banWithReasonRes.data.error?.includes('is not running') || banWithReasonRes.data.error?.includes('çalışmıyor')))) {
      throw new Error(`Ban with reason failed: ${JSON.stringify(banWithReasonRes.data)}`);
    }
  });

  // 8. WebSocket connection & subscriptions
  await assertTest('WebSocket Protocol (/ws)', async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?token=${authToken}`);
      let receivedAck = false;
      let receivedMetrics = false;
      let receivedHistory = false;

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('WebSocket test timed out waiting for events.'));
      }, 6000);

      ws.on('open', () => {
        // Subscribe to metrics
        ws.send(JSON.stringify({ type: 'subscribe_metrics' }));
        // Subscribe to console
        if (testServerId) {
          ws.send(JSON.stringify({ type: 'subscribe_console', serverId: testServerId }));
        }
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.type === 'connection_ack') {
            receivedAck = true;
          }
          if (msg.type === 'metrics_update') {
            if (msg.host && msg.servers) {
              receivedMetrics = true;
            }
          }
          if (msg.type === 'console_history') {
            receivedHistory = true;
          }

          if (receivedAck && receivedMetrics && (receivedHistory || !testServerId)) {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        } catch (e) {
          reject(e);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  // Clean up test server
  if (testServerId) {
    await assertTest(`Cleanup test server (${testServerId})`, async () => {
      const res = await request({
        url: `/api/servers/${testServerId}?deleteFiles=true`,
        method: 'DELETE'
      });
      if (res.status !== 200) {
        throw new Error(`Delete server failed: ${JSON.stringify(res.data)}`);
      }
    });
  }

  // 10. Server Creation with Jar Download and WebSocket Progress
  await assertTest('Server Creation via Core Download & WebSocket Progress (/api/servers/create)', async () => {
    // Connect WebSocket to track download_progress
    const ws = new WebSocket(`${WS_URL}?token=${authToken}`);
    const progressEvents = [];
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.type === 'download_progress') {
          progressEvents.push(msg);
        }
      } catch (e) {}
    });

    const createPayload = {
      name: 'Backend-Core-Purpur-Test',
      type: 'purpur',
      version: '26.3',
      port: 25590,
      ramMin: '2G',
      ramMax: '4G'
    };

    const res = await request({
      url: '/api/servers/create',
      method: 'POST'
    }, createPayload);

    ws.close();

    if (res.status !== 201 || !res.data || !res.data.id) {
      throw new Error(`Server creation failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    const createdServer = res.data;
    const srvDir = createdServer.directory;
    console.log(`\n    Created Server ID: ${createdServer.id}, Dir: ${srvDir}, Java: ${createdServer.javaPath}`);

    // Verify Auto Java selection respects documented requirements and detected installed runtime precedence
    const javaCompatibility = require('../src/system/javaCompatibility');
    const javaDetector = require('../src/system/javaDetector');
    const req = javaCompatibility.getJavaRequirements(createPayload.type, createPayload.version);
    const installed = javaDetector.detectJavaInstallations();
    const installedRec = installed.find((j) => j.majorVersion === req.recommendedJava);

    if (installedRec) {
      // Installed recommended Java (Java 25 for Purpur 26.3) must take precedence
      if (createdServer.javaPath !== installedRec.path) {
        throw new Error(`Expected recommended Java ${req.recommendedJava} (${installedRec.path}), but got: ${createdServer.javaPath}`);
      }
    } else {
      // Otherwise, must choose a documented compatible alternative meeting minimum requirements (>= 25)
      const selectedInfo = javaDetector.inspectJavaExecutable(createdServer.javaPath);
      const selectedMajor = selectedInfo?.majorVersion || (createdServer.javaPath.match(/jdk-?(\d+)/i) ? parseInt(RegExp.$1, 10) : null);
      if (!selectedMajor || selectedMajor < req.minJava) {
        throw new Error(`Selected Java (${createdServer.javaPath}) does not meet minimum Java ${req.minJava} for ${createPayload.type} ${createPayload.version}`);
      }
      if (!javaCompatibility.isJavaCompatible(selectedMajor, createPayload.type, createPayload.version)) {
        throw new Error(`Selected Java (${createdServer.javaPath}, Java ${selectedMajor}) is incompatible with ${createPayload.type} ${createPayload.version}`);
      }
    }

    // Verify eula.txt, server.properties, server.jar
    if (!fs.existsSync(path.join(srvDir, 'eula.txt'))) {
      throw new Error('eula.txt missing');
    }
    const props = fs.readFileSync(path.join(srvDir, 'server.properties'), 'utf8');
    if (!props.includes(`server-port=${createdServer.port}`)) {
      throw new Error(`server.properties missing port ${createdServer.port}`);
    }
    const expectedJar = createdServer.jarFile || 'purpur.jar';
    const jarStat = fs.statSync(path.join(srvDir, expectedJar));
    if (jarStat.size < 10 * 1024 * 1024) {
      throw new Error(`${expectedJar} is too small: ${jarStat.size} bytes`);
    }

    console.log(`    Jar downloaded (${expectedJar}): ${(jarStat.size / 1024 / 1024).toFixed(1)} MB, ${progressEvents.length} progress events captured`);

    // Clean up created server
    const serverRegistry = require('../src/servers/serverRegistry');
    serverRegistry.delete(createdServer.id);
    if (fs.existsSync(srvDir)) {
      fs.rmSync(srvDir, { recursive: true, force: true });
    }
  });

  // 14. Port Availability Check API
  await assertTest('Port Availability Check API (/api/servers/check-port)', async () => {
    // 14a. Missing port parameter
    const missingRes = await request({ url: '/api/servers/check-port' });
    if (missingRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for missing port, got ${missingRes.status}`);
    }

    // 14b. Invalid port parameter
    const invalidRes = await request({ url: '/api/servers/check-port?port=999999' });
    if (invalidRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for out-of-range port, got ${invalidRes.status}`);
    }

    // 14c. Check available port (e.g. 29876)
    const availRes = await request({ url: '/api/servers/check-port?port=29876' });
    if (availRes.status !== 200 || typeof availRes.data.available !== 'boolean') {
      throw new Error(`Invalid response for available port: ${JSON.stringify(availRes.data)}`);
    }

    // 14d. Check in-use port (daemon port)
    const usedRes = await request({ url: `/api/servers/check-port?port=${PORT}` });
    if (usedRes.status !== 200 || usedRes.data.available !== false) {
      throw new Error(`Expected port ${PORT} to be reported unavailable: ${JSON.stringify(usedRes.data)}`);
    }
  });

  // 15. Backup Engine & API (/api/backups & /api/servers/:id/backups)
  await assertTest('Backup Engine & API (Create, Exclude, List, Restore, Download, Delete)', async () => {
    const serverRegistry = require('../src/servers/serverRegistry');
    const backupServerId = 'bck-test-' + Date.now().toString(36);
    const backupServerDir = path.join(require('../config').SERVERS_DIR, backupServerId);
    
    fs.mkdirSync(path.join(backupServerDir, 'world'), { recursive: true });
    fs.mkdirSync(path.join(backupServerDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(backupServerDir, 'cache'), { recursive: true });
    
    fs.writeFileSync(path.join(backupServerDir, 'server.properties'), 'server-port=25599\nmotd=Backup Test\n');
    fs.writeFileSync(path.join(backupServerDir, 'world', 'level.dat'), 'WORLD_DATA_BINARY');
    fs.writeFileSync(path.join(backupServerDir, 'logs', 'latest.log'), 'LOG_DATA_EXCLUDE');
    fs.writeFileSync(path.join(backupServerDir, 'cache', 'temp.cache'), 'CACHE_DATA_EXCLUDE');

    serverRegistry.register({
      id: backupServerId,
      name: 'Backup Test Server',
      directory: backupServerDir,
      port: 25599
    });

    try {
      // 15a. List backups initially
      const listInit = await request({ url: `/api/servers/${backupServerId}/backups` });
      if (listInit.status !== 200 || !Array.isArray(listInit.data)) {
        throw new Error(`Failed to list server backups: ${listInit.status}`);
      }

      // 15b. Create Gzip backup with exclusions
      const createRes = await request({
        url: `/api/servers/${backupServerId}/backups`,
        method: 'POST'
      }, {
        name: 'Automated Test Backup',
        compression: 'gzip',
        exclusions: ['logs', 'cache', '*.log']
      });

      if (createRes.status !== 201 || !createRes.data.id) {
        throw new Error(`Failed to create backup: ${JSON.stringify(createRes.data)}`);
      }
      const bckId = createRes.data.id;
      const bckFilePath = createRes.data.filePath;

      if (!fs.existsSync(bckFilePath) || fs.statSync(bckFilePath).size === 0) {
        throw new Error(`Backup file does not exist or is empty: ${bckFilePath}`);
      }

      // 15c. List via global /api/backups
      const globalList = await request({ url: '/api/backups' });
      if (globalList.status !== 200 || !globalList.data.some((b) => b.id === bckId)) {
        throw new Error('Created backup not found in global /api/backups');
      }

      // 15d. Download backup
      const downloadRes = await request({ url: `/api/servers/${backupServerId}/backups/${bckId}/download` });
      if (downloadRes.status !== 200 || !downloadRes.data) {
        throw new Error(`Failed to download backup: ${downloadRes.status}`);
      }

      // 15e. Test ZIP backup creation
      const zipRes = await request({
        url: `/api/servers/${backupServerId}/backups`,
        method: 'POST'
      }, {
        name: 'Zip Test Backup',
        compression: 'zip',
        exclusions: ['logs']
      });

      if (zipRes.status !== 201 || !zipRes.data.id || !zipRes.data.filePath.endsWith('.zip')) {
        throw new Error(`Failed to create zip backup: ${JSON.stringify(zipRes.data)}`);
      }
      const zipBckId = zipRes.data.id;

      // 15f. Restore backup (delete world/level.dat then restore)
      fs.unlinkSync(path.join(backupServerDir, 'world', 'level.dat'));
      if (fs.existsSync(path.join(backupServerDir, 'world', 'level.dat'))) {
        throw new Error('Failed to delete world file before restore');
      }

      const restoreRes = await request({
        url: `/api/servers/${backupServerId}/backups/${bckId}/restore`,
        method: 'POST'
      });
      if (restoreRes.status !== 200) {
        throw new Error(`Restore failed: ${JSON.stringify(restoreRes.data)}`);
      }

      // Verify file was restored
      if (!fs.existsSync(path.join(backupServerDir, 'world', 'level.dat'))) {
        throw new Error('Restored world file is missing after restore');
      }

      // 15g. Delete backups
      const del1 = await request({
        url: `/api/servers/${backupServerId}/backups/${bckId}`,
        method: 'DELETE'
      });
      if (del1.status !== 200) {
        throw new Error(`Delete backup failed: ${del1.status}`);
      }
      if (fs.existsSync(bckFilePath)) {
        throw new Error('Backup file still exists after deletion');
      }

      const del2 = await request({
        url: `/api/backups/${zipBckId}`,
        method: 'DELETE'
      });
      if (del2.status !== 200) {
        throw new Error(`Delete zip backup failed: ${del2.status}`);
      }
    } finally {
      // Clean up server
      serverRegistry.delete(backupServerId);
      if (fs.existsSync(backupServerDir)) {
        fs.rmSync(backupServerDir, { recursive: true, force: true });
      }
    }
  });

  // 16. Auth Security: Rejection of Stale Cookie & Spoofed Forwarded Headers; Acceptance of Valid Cookie / Bearer
  await assertTest('Auth Security: Reject invalid cookie & spoofed X-Forwarded-For; Accept valid cookie & bearer', async () => {
    const staleCookie = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxLCJpYXQiOjE3OTAzNTk1NzEsIm1mYSI6ZmFsc2V9.wyaFtt0UfaNCGJ868Jd7u1fDiFkULR8R-8mLnek8a9s; _xsrf=2|9c8a2372; p2p_session=68109b068b21';
    const oldToken = authToken;
    authToken = null;
    try {
      // 1. Stale/invalid cookie MUST be rejected with HTTP 401 Unauthorized
      const staleRes = await request({
        url: '/api/servers/create-with-core',
        method: 'POST',
        headers: {
          'Cookie': staleCookie
        }
      }, {});

      if (staleRes.status !== 401) {
        throw new Error(`Expected 401 Unauthorized for stale/invalid cookie, but received HTTP ${staleRes.status}: ${JSON.stringify(staleRes.data)}`);
      }

      // 2. Spoofed X-Forwarded-For with no token MUST be rejected with HTTP 401 Unauthorized
      const spoofRes = await request({
        url: '/api/servers/create-with-core',
        method: 'POST',
        headers: {
          'X-Forwarded-For': '127.0.0.1'
        }
      }, {});

      if (spoofRes.status !== 401) {
        throw new Error(`Expected 401 Unauthorized for spoofed X-Forwarded-For without valid token, got HTTP ${spoofRes.status}`);
      }

      // 3. Valid cookie token MUST be accepted (reaching controller handler, returning 400 because name is missing)
      const validCookieRes = await request({
        url: '/api/servers/create-with-core',
        method: 'POST',
        headers: {
          'Cookie': `token=${oldToken}`
        }
      }, {});

      if (validCookieRes.status === 401) {
        throw new Error('Valid cookie was rejected with 401 Unauthorized.');
      }
      const isExpectedNameError = (err) => err === 'Sunucu adı metin formatında olmalı ve boş bırakılmamalıdır.' || err === 'Sunucu adı zorunludur.';
      if (validCookieRes.status !== 400 || !isExpectedNameError(validCookieRes.data?.error)) {
        throw new Error(`Expected controller 400 server name error with valid cookie, got ${validCookieRes.status}: ${JSON.stringify(validCookieRes.data)}`);
      }

      // 4. Valid Bearer token MUST be accepted
      authToken = oldToken;
      const validBearerRes = await request({
        url: '/api/servers/create-with-core',
        method: 'POST'
      }, {});

      if (validBearerRes.status === 401) {
        throw new Error('Valid Bearer token was rejected with 401 Unauthorized.');
      }
      if (validBearerRes.status !== 400 || !isExpectedNameError(validBearerRes.data?.error)) {
        throw new Error(`Expected controller 400 server name error with valid Bearer token, got ${validBearerRes.status}: ${JSON.stringify(validBearerRes.data)}`);
      }
    } finally {
      authToken = oldToken;
    }
  });

  // 17. RAM Formatting and JVM Startup Safety
  await assertTest('RAM Formatting and JVM argument validation', async () => {
    const serverRegistry = require('../src/servers/serverRegistry');
    const ramServerId = 'ram-test-' + Date.now().toString(36);
    const ramServerDir = path.join(require('../config').SERVERS_DIR, ramServerId);
    fs.mkdirSync(ramServerDir, { recursive: true });

    try {
      const server = serverRegistry.register({
        id: ramServerId,
        name: 'RAM Format Test',
        directory: ramServerDir,
        minRam: 4, // passed as number
        maxRam: '8 GB' // passed with spaces and unit
      });

      if (server.minRam !== '4G') {
        throw new Error(`Expected minRam to be formatted to "4G", got "${server.minRam}"`);
      }
      if (server.maxRam !== '8G') {
        throw new Error(`Expected maxRam to be formatted to "8G", got "${server.maxRam}"`);
      }

      // Update via registry
      const updated = serverRegistry.update(ramServerId, { minRam: ' 4096 MB ', maxRam: 16 });
      if (updated.minRam !== '4096M') {
        throw new Error(`Expected updated minRam to be "4096M", got "${updated.minRam}"`);
      }
      if (updated.maxRam !== '16G') {
        throw new Error(`Expected updated maxRam to be "16G", got "${updated.maxRam}"`);
      }
    } finally {
      serverRegistry.delete(ramServerId);
      if (fs.existsSync(ramServerDir)) {
        fs.rmSync(ramServerDir, { recursive: true, force: true });
      }
    }
  });

  // 18. Dangerous destination directory rejection in Backup Engine
  await assertTest('Dangerous destination directory rejected by backup engine', async () => {
    const backupManager = require('../src/servers/backupManager');
    let rejected = false;
    try {
      await backupManager.createBackup('non-existent', { destDir: '/etc/cron.d' });
    } catch (err) {
      if (err.message.includes('Destination directory is not permitted') || err.message.includes('not found')) {
        rejected = true;
      }
    }
    if (!rejected) {
      throw new Error('Expected backup to /etc/cron.d to be rejected!');
    }
  });

  // 19. Cross-server backup isolation on restore and delete
  await assertTest('Cross-server backup isolation on restore and delete', async () => {
    const serverRegistry = require('../src/servers/serverRegistry');
    const backupManager = require('../src/servers/backupManager');

    const srv1Id = 'srv1-' + Date.now().toString(36);
    const srv2Id = 'srv2-' + Date.now().toString(36);
    const dir1 = path.join(require('../config').SERVERS_DIR, srv1Id);
    const dir2 = path.join(require('../config').SERVERS_DIR, srv2Id);
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir1, 'server.properties'), 'motd=Srv1\n');

    serverRegistry.register({ id: srv1Id, name: 'Srv1', directory: dir1 });
    serverRegistry.register({ id: srv2Id, name: 'Srv2', directory: dir2 });

    let bck = null;
    try {
      bck = await backupManager.createBackup(srv1Id, { name: 'Isolation Test' });

      // Attempt restoring srv1 backup into srv2
      let restoreBlocked = false;
      try {
        await backupManager.restoreBackup(srv2Id, bck.id);
      } catch (err) {
        if (err.message.includes('does not belong to server')) {
          restoreBlocked = true;
        }
      }
      if (!restoreBlocked) {
        throw new Error('Expected cross-server restore to be blocked with isolation error!');
      }

      // Attempt deleting srv1 backup via srv2
      let deleteBlocked = false;
      try {
        backupManager.deleteBackup(bck.id, srv2Id);
      } catch (err) {
        if (err.message.includes('does not belong to server')) {
          deleteBlocked = true;
        }
      }
      if (!deleteBlocked) {
        throw new Error('Expected cross-server delete to be blocked with isolation error!');
      }
    } finally {
      if (bck) {
        try { backupManager.deleteBackup(bck.id); } catch (e) {}
      }
      serverRegistry.delete(srv1Id);
      serverRegistry.delete(srv2Id);
      if (fs.existsSync(dir1)) fs.rmSync(dir1, { recursive: true, force: true });
      if (fs.existsSync(dir2)) fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  // 20. String port collision detection and out-of-range safety in check-port
  await assertTest('Port Check API handles string ports and boundary conditions', async () => {
    const serverRegistry = require('../src/servers/serverRegistry');
    const dummyServerId = 'dummy-port-' + Date.now().toString(36);
    const dummyDir = path.join(require('../config').SERVERS_DIR, dummyServerId);
    fs.mkdirSync(dummyDir, { recursive: true });

    serverRegistry.register({
      id: dummyServerId,
      name: 'Dummy Port Server',
      directory: dummyDir,
      port: 25593 // registered as 25593
    });

    try {
      const res = await request({ url: '/api/servers/check-port?port=25593' });
      if (res.status !== 200 || res.data.available !== false) {
        throw new Error(`Expected port 25593 to conflict with registered server: ${JSON.stringify(res.data)}`);
      }

      // Out of bounds port
      const invalidRes = await request({ url: '/api/servers/check-port?port=99999' });
      if (invalidRes.status !== 400 || invalidRes.data.available !== false) {
        throw new Error(`Expected port 99999 to return 400 Bad Request: ${JSON.stringify(invalidRes.data)}`);
      }

      const negativeRes = await request({ url: '/api/servers/check-port?port=-1' });
      if (negativeRes.status !== 400 || negativeRes.data.available !== false) {
        throw new Error(`Expected port -1 to return 400 Bad Request: ${JSON.stringify(negativeRes.data)}`);
      }
    } finally {
      serverRegistry.delete(dummyServerId);
      if (fs.existsSync(dummyDir)) {
        fs.rmSync(dummyDir, { recursive: true, force: true });
      }
    }
  });

  console.log('\n====================================================');
  console.log(`Tests Finished: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// If executed directly
if (require.main === module) {
  runTests().catch((err) => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
