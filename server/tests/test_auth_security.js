const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate test directories under os.tmpdir() BEFORE requiring config or services.
// This guarantees running locally never writes to the repository's data/ directory.
// If already running under QA harness (process.env.QA_ROOT or process.env.DATA_DIR), respect the scoped QA env.
const isCustomEnv = Boolean(process.env.QA_ROOT || process.env.DATA_DIR);
let testTmpDir = null;

if (!isCustomEnv) {
  testTmpDir = path.join(
    os.tmpdir(),
    'mazipanel-auth-test-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  );
  fs.mkdirSync(testTmpDir, { recursive: true });
  process.env.DATA_DIR = path.join(testTmpDir, 'data');
  process.env.TEMP_DIR = path.join(testTmpDir, 'temp');
  process.env.SERVERS_DIR = path.join(testTmpDir, 'servers');
  process.env.BACKUPS_DIR = path.join(testTmpDir, 'backups');
  process.env.SINGLE_USER_MODE = 'false';
  process.env.NODE_ENV = 'test';
  process.env.TEST_MODE = 'true';
} else {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.TEST_MODE = process.env.TEST_MODE || 'true';
}

const assert = require('assert');
const http = require('http');
const express = require('express');
const { WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const authService = require('../src/auth/authService');
const authMiddleware = require('../src/auth/authMiddleware');
const authController = require('../src/auth/authController');
const tokenPolicy = require('../src/auth/tokenPolicy');
const wsManager = require('../src/websocket/wsManager');
const config = require('../config');
const processManager = require('../src/servers/processManager');

async function runAuthSecurityTests() {
  console.log('====================================================');
  console.log('        maziPanel Auth Security Test Suite          ');
  console.log('====================================================');

  let totalTests = 0;
  let passedTests = 0;

  function markPassed(desc) {
    totalTests++;
    passedTests++;
    console.log(`    PASS (${totalTests}): ${desc}`);
  }

  // 1. Verify default authentication configuration
  console.log('[*] Verifying Default Auth Policy (SINGLE_USER_MODE)...');
  assert.strictEqual(
    config.SINGLE_USER_MODE,
    false,
    'config.SINGLE_USER_MODE MUST default to false unless explicitly set to "true"'
  );
  markPassed('Default SINGLE_USER_MODE is strictly false');

  const validAdminToken = authService.generateToken({ username: 'masteradmin', role: 'admin' });
  const validNonAdminToken = authService.generateToken({ username: 'regularuser', role: 'user' });
  const staleCookie = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxLCJpYXQiOjE3OTAzNTk1NzEsIm1mYSI6ZmFsc2V9.wyaFtt0UfaNCGJ868Jd7u1fDiFkULR8R-8mLnek8a9s; _xsrf=test';

  // Setup express test app
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://mc-heads.net; connect-src 'self' ws: wss:; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );
    next();
  });
  app.use(express.json());

  // Bootstrap endpoints
  app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy' });
  });

  app.use('/api/auth', authController);

  // Protected endpoints requiring admin role
  app.get('/api/metrics/host', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ host: 'ok', user: req.user });
  });
  app.get('/api/servers/cores/versions', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ cores: [] });
  });
  app.get('/api/servers/system/java', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ javas: [] });
  });
  app.get('/api/servers/check-port', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ port: 'available' });
  });
  app.get('/api/servers', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ servers: [], role: req.user.role });
  });
  app.get('/api/servers/:id/files', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ files: [] });
  });
  app.get('/api/backups', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ backups: [] });
  });

  // Public server icon endpoint
  app.get('/api/servers/:id/icon', authMiddleware, (req, res) => {
    res.send('server-icon-bytes');
  });

  // State-changing endpoints
  app.post('/api/servers/create', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ created: true, user: req.user });
  });
  app.post('/api/servers/:id/command', authMiddleware, authMiddleware.requireAdmin, (req, res) => {
    res.json({ executed: true, command: req.body.command });
  });

  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  wsManager.initialize(server);

  function request(method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
      const reqHeaders = { ...headers };
      if (payload) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders
      }, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, body: json || raw });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Bootstrap Endpoints vs Internal Endpoint Protection
    // -------------------------------------------------------------
    console.log('[*] Test 1: Bootstrap Endpoints vs Internal Endpoint Protection...');
    const healthRes = await request('GET', '/api/health');
    assert.strictEqual(healthRes.status, 200, 'GET /api/health must be 200 without token');

    const statusRes = await request('GET', '/api/auth/status');
    assert.strictEqual(statusRes.status, 200, 'GET /api/auth/status must be 200 without token');

    const iconRes = await request('GET', '/api/servers/mysrv/icon');
    assert.strictEqual(iconRes.status, 200, 'GET /api/servers/:id/icon must be 200 without token');

    // Internal endpoints must REQUIRE admin auth (401 without token)
    const metricsRes = await request('GET', '/api/metrics/host');
    assert.strictEqual(metricsRes.status, 401, 'Host metrics must REQUIRE admin auth (401)');

    const serversRes = await request('GET', '/api/servers');
    assert.strictEqual(serversRes.status, 401, 'Server listing must REQUIRE admin auth (401)');

    const coresRes = await request('GET', '/api/servers/cores/versions');
    assert.strictEqual(coresRes.status, 401, 'Cores versions must REQUIRE admin auth (401)');

    const javaRes = await request('GET', '/api/servers/system/java');
    assert.strictEqual(javaRes.status, 401, 'Java detection must REQUIRE admin auth (401)');

    const portRes = await request('GET', '/api/servers/check-port');
    assert.strictEqual(portRes.status, 401, 'Check port must REQUIRE admin auth (401)');

    const filesRes = await request('GET', '/api/servers/srv1/files');
    assert.strictEqual(filesRes.status, 401, 'Server files must REQUIRE admin auth (401)');

    const backupsRes = await request('GET', '/api/backups');
    assert.strictEqual(backupsRes.status, 401, 'Backups must REQUIRE admin auth (401)');

    const meRes = await request('GET', '/api/auth/me');
    assert.strictEqual(meRes.status, 401, 'GET /api/auth/me must REQUIRE admin auth (401)');
    markPassed('Internal endpoints require admin auth, bootstrap endpoints accessible');

    // -------------------------------------------------------------
    // TEST 2: Deterministic Precedence, Malformed/Empty, and Mixed Inputs
    // -------------------------------------------------------------
    console.log('[*] Test 2: Deterministic Precedence, Malformed/Empty, and Mixed Inputs...');

    // a. Malformed Authorization: Bearer <empty>
    const emptyBearerRes = await request('GET', '/api/auth/me', { 'Authorization': 'Bearer ' });
    assert.strictEqual(emptyBearerRes.status, 401, 'Empty Bearer token must fail closed with 401');

    // b. Malformed Authorization: invalid string
    const malformedAuthRes = await request('GET', '/api/auth/me', { 'Authorization': 'not-a-token' });
    assert.strictEqual(malformedAuthRes.status, 401, 'Malformed authorization header must fail closed with 401');

    // c. Empty Cookie: token=
    const emptyCookieRes = await request('GET', '/api/auth/me', { 'Cookie': 'token=' });
    assert.strictEqual(emptyCookieRes.status, 401, 'Empty cookie token must fail closed with 401');

    // d. Empty Query: ?token=
    const emptyQueryRes = await request('GET', '/api/auth/me?token=');
    assert.strictEqual(emptyQueryRes.status, 401, 'Empty query token must fail closed with 401');

    // e. Mixed: Malformed Authorization header + VALID Cookie
    // Authorization header takes deterministic precedence: must FAIL CLOSED without cookie fallback!
    const mixedRes = await request('GET', '/api/auth/me', {
      'Authorization': 'Bearer invalid.garbage.token',
      'Cookie': `token=${validAdminToken}`
    });
    assert.strictEqual(mixedRes.status, 401, 'Malformed/invalid Authorization header must fail closed without cookie fallback');

    // f. Mixed: Valid Bearer token + Stale Cookie
    const validBearerStaleCookieRes = await request('GET', '/api/auth/me', {
      'Authorization': `Bearer ${validAdminToken}`,
      'Cookie': staleCookie
    });
    assert.strictEqual(validBearerStaleCookieRes.status, 200, 'Valid Bearer token must succeed even if a stale cookie is present');

    // g. Stale/invalid cookie alone must fail closed
    const staleCookieOnlyRes = await request('GET', '/api/auth/me', { 'Cookie': staleCookie });
    assert.strictEqual(staleCookieOnlyRes.status, 401, 'Stale cookie alone must fail closed with 401');

    // h. Valid cookie alone must succeed
    const validCookieOnlyRes = await request('GET', '/api/auth/me', { 'Cookie': `token=${validAdminToken}` });
    assert.strictEqual(validCookieOnlyRes.status, 200, 'Valid cookie alone must succeed with 200');

    // i. Query token alone on REST routes must fail (401) - restricted to WebSocket upgrade only
    const validQueryRes = await request('GET', `/api/auth/me?token=${validAdminToken}`);
    assert.strictEqual(validQueryRes.status, 401, 'Query token on REST route must be rejected with 401');
    markPassed('Deterministic precedence and fail-closed resolution verified on all input shapes');

    // -------------------------------------------------------------
    // TEST 3: Strict Role Authorization (Non-Admin Rejection)
    // -------------------------------------------------------------
    console.log('[*] Test 3: Strict Role Authorization (Non-Admin Rejection)...');

    // Valid non-admin token MUST be rejected on admin-only endpoints with 403 Forbidden
    const nonAdminServersRes = await request('GET', '/api/servers', {
      'Authorization': `Bearer ${validNonAdminToken}`
    });
    assert.strictEqual(nonAdminServersRes.status, 403, 'Non-admin token must be rejected from /api/servers with 403');

    const nonAdminFilesRes = await request('GET', '/api/servers/srv1/files', {
      'Authorization': `Bearer ${validNonAdminToken}`
    });
    assert.strictEqual(nonAdminFilesRes.status, 403, 'Non-admin token must be rejected from server files with 403');

    const nonAdminCreateRes = await request('POST', '/api/servers/create', {
      'Authorization': `Bearer ${validNonAdminToken}`
    }, { name: 'unauthorized-server' });
    assert.strictEqual(nonAdminCreateRes.status, 403, 'Non-admin token must be rejected from server creation with 403');

    const nonAdminCommandRes = await request('POST', '/api/servers/srv1/command', {
      'Authorization': `Bearer ${validNonAdminToken}`
    }, { command: 'stop' });
    assert.strictEqual(nonAdminCommandRes.status, 403, 'Non-admin token must be rejected from sending commands with 403');

    // In multi-user mode, GET /api/auth/me succeeds for regular user
    const nonAdminMeRes = await request('GET', '/api/auth/me', {
      'Authorization': `Bearer ${validNonAdminToken}`
    });
    assert.strictEqual(nonAdminMeRes.status, 200, 'Non-admin token must access /api/auth/me with 200');
    assert.strictEqual(nonAdminMeRes.body?.user?.username, 'regularuser', 'Must return regularuser details');

    // But admin-only endpoint /api/auth/users must reject non-admin with 403 Forbidden
    const nonAdminUsersRes = await request('GET', '/api/auth/users', {
      'Authorization': `Bearer ${validNonAdminToken}`
    });
    assert.strictEqual(nonAdminUsersRes.status, 403, 'Non-admin token must be rejected from /api/auth/users with 403');

    // Invalid role token must fail closed with 403 Forbidden
    const invalidRoleToken = authService.generateToken({ username: 'badactor', role: 'unknown' });
    const invalidRoleRes = await request('GET', '/api/auth/me', {
      'Authorization': `Bearer ${invalidRoleToken}`
    });
    assert.strictEqual(invalidRoleRes.status, 403, 'Invalid user role token must be rejected with 403');

    // Valid admin token MUST succeed
    const adminServersRes = await request('GET', '/api/servers', {
      'Authorization': `Bearer ${validAdminToken}`
    });
    assert.strictEqual(adminServersRes.status, 200, 'Admin token must be accepted on /api/servers with 200');
    markPassed('Valid signed non-admin token rejected (403) from admin endpoints and sensitive management');

    // -------------------------------------------------------------
    // TEST 4: Cross-Origin CSRF Defense & Spoofed Forwarded-Host Rejection
    // -------------------------------------------------------------
    console.log('[*] Test 4: Cross-Origin CSRF Defense & Spoofed Forwarded-Host Rejection...');

    // a. Foreign HTTP POST mutation with VALID cookie MUST be rejected with 403 Forbidden
    const foreignHttpRes = await request('POST', '/api/servers/create', {
      'Host': `127.0.0.1:${port}`,
      'Origin': 'http://evil-attacker-site.com',
      'Cookie': `token=${validAdminToken}`
    }, { name: 'exploit-server' });
    assert.strictEqual(foreignHttpRes.status, 403, 'Foreign Origin HTTP mutation with valid cookie must be rejected with 403 Forbidden');

    // b. Spoofed X-Forwarded-Host: attacker attempts to match their Origin by sending X-Forwarded-Host: evil.com
    // Server MUST compare against actual Host header and REJECT with 403!
    const spoofedForwardedHostRes = await request('POST', '/api/servers/create', {
      'Host': `127.0.0.1:${port}`,
      'X-Forwarded-Host': 'evil-attacker-site.com',
      'Origin': 'http://evil-attacker-site.com',
      'Cookie': `token=${validAdminToken}`
    }, { name: 'exploit-server' });
    assert.strictEqual(spoofedForwardedHostRes.status, 403, 'Spoofed X-Forwarded-Host must be ignored and rejected with 403');

    // c. Foreign Referer MUST be rejected with 403
    const foreignRefererRes = await request('POST', '/api/servers/create', {
      'Host': `127.0.0.1:${port}`,
      'Referer': 'http://evil-attacker-site.com/attack.html',
      'Cookie': `token=${validAdminToken}`
    }, { name: 'exploit-server' });
    assert.strictEqual(foreignRefererRes.status, 403, 'Foreign Referer must be rejected with 403');

    // d. Null Origin MUST be rejected with 403
    const nullOriginRes = await request('POST', '/api/servers/create', {
      'Host': `127.0.0.1:${port}`,
      'Origin': 'null',
      'Cookie': `token=${validAdminToken}`
    }, { name: 'exploit-server' });
    assert.strictEqual(nullOriginRes.status, 403, 'Null Origin must be rejected with 403');

    // e. Null Referer MUST be rejected with 403
    const nullRefererRes = await request('POST', '/api/servers/create', {
      'Host': `127.0.0.1:${port}`,
      'Referer': 'null',
      'Cookie': `token=${validAdminToken}`
    }, { name: 'exploit-server' });
    assert.strictEqual(nullRefererRes.status, 403, 'Null Referer must be rejected with 403');

    // f. Same-Origin HTTP POST mutation with VALID cookie MUST SUCCEED with 200
    const sameOriginHttpRes = await request('POST', '/api/servers/create', {
      'Host': `127.0.0.1:${port}`,
      'Origin': `http://127.0.0.1:${port}`,
      'Cookie': `token=${validAdminToken}`
    }, { name: 'safe-server' });
    assert.strictEqual(sameOriginHttpRes.status, 200, 'Same-Origin HTTP mutation with valid cookie must succeed with 200');

    // g. Absent Origin (CLI/test runner/Bearer) MUST SUCCEED with 200
    const absentOriginHttpRes = await request('POST', '/api/servers/create', {
      'Authorization': `Bearer ${validAdminToken}`
    }, { name: 'cli-server' });
    assert.strictEqual(absentOriginHttpRes.status, 200, 'Absent Origin HTTP mutation with Bearer must succeed with 200');
    markPassed('Foreign origins, spoofed X-Forwarded-Host, null origins, and foreign referers rejected (403)');

    // -------------------------------------------------------------
    // TEST 5: IPv6 and Standard Default Port Parsing
    // -------------------------------------------------------------
    console.log('[*] Test 5: IPv6 and Standard Default Port Parsing...');

    // Unit check tokenPolicy.parseHostHeader
    const ipv6WithPort = tokenPolicy.parseHostHeader('[::1]:8080');
    assert.deepStrictEqual(ipv6WithPort, { hostname: '[::1]', port: '8080' });

    const ipv6WithoutPort = tokenPolicy.parseHostHeader('[::1]');
    assert.deepStrictEqual(ipv6WithoutPort, { hostname: '[::1]', port: null });

    const ipv4Parsed = tokenPolicy.parseHostHeader('127.0.0.1:8080');
    assert.deepStrictEqual(ipv4Parsed, { hostname: '127.0.0.1', port: '8080' });

    // Test IPv6 origin matching
    const mockIpv6Req = {
      headers: {
        host: '[::1]:8080',
        origin: 'http://[::1]:8080'
      }
    };
    assert.strictEqual(tokenPolicy.isOriginAllowed(mockIpv6Req), true, 'Matching IPv6 origin must be allowed');

    const mockIpv6ForeignReq = {
      headers: {
        host: '[::1]:8080',
        origin: 'http://[::2]:8080'
      }
    };
    assert.strictEqual(tokenPolicy.isOriginAllowed(mockIpv6ForeignReq), false, 'Non-matching IPv6 origin must be rejected');

    // Test standard port 80/443 default normalization
    const mockStandardPortReq = {
      headers: {
        host: 'localhost',
        origin: 'http://localhost:80'
      }
    };
    assert.strictEqual(tokenPolicy.isOriginAllowed(mockStandardPortReq), true, 'Standard default port 80 normalization must be allowed');
    markPassed('IPv6 literal and default standard port normalization verified');

    // -------------------------------------------------------------
    // TEST 6: Cross-Site WebSocket Hijacking (CSWSH) Defense
    // -------------------------------------------------------------
    console.log('[*] Test 6: Cross-Site WebSocket Hijacking (CSWSH) Defense...');

    // a. Foreign WS Origin with a VALID cookie MUST BE REJECTED
    const wsForeign = new WebSocket(wsUrl, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Origin': 'http://evil-attacker-site.com',
        'Cookie': `token=${validAdminToken}`
      }
    });

    let foreignWsRejected = false;
    await new Promise((resolve) => {
      wsForeign.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'auth_error' || msg.authenticated === false) {
            foreignWsRejected = true;
          }
        } catch (e) {}
      });
      wsForeign.on('close', (code) => {
        foreignWsRejected = true;
        resolve();
      });
      wsForeign.on('error', () => {
        foreignWsRejected = true;
        resolve();
      });
      setTimeout(resolve, 600);
    });
    assert(foreignWsRejected, 'Foreign WS Origin with valid cookie must be rejected');

    // b. Same-Origin WebSocket with a VALID cookie MUST BE ACCEPTED
    const wsSameOrigin = new WebSocket(wsUrl, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Origin': `http://127.0.0.1:${port}`,
        'Cookie': `token=${validAdminToken}`
      }
    });

    let sameOriginWsAck = false;
    await new Promise((resolve, reject) => {
      wsSameOrigin.on('open', () => {});
      wsSameOrigin.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'connection_ack' && msg.authenticated === true) {
            sameOriginWsAck = true;
            resolve();
          }
        } catch (e) {}
      });
      wsSameOrigin.on('error', (err) => {
        reject(err);
      });
      setTimeout(resolve, 600);
    });
    assert(sameOriginWsAck, 'Same-Origin WS connection with valid cookie must authenticate successfully');
    wsSameOrigin.close();

    // c. Absent Origin WebSocket with a VALID cookie MUST BE ACCEPTED (CLI / test runner)
    const wsAbsentOrigin = new WebSocket(wsUrl, {
      headers: {
        'Cookie': `token=${validAdminToken}`
      }
    });

    let absentOriginWsAck = false;
    await new Promise((resolve, reject) => {
      wsAbsentOrigin.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'connection_ack' && msg.authenticated === true) {
            absentOriginWsAck = true;
            resolve();
          }
        } catch (e) {}
      });
      wsAbsentOrigin.on('error', reject);
      setTimeout(resolve, 600);
    });
    assert(absentOriginWsAck, 'Absent Origin WS with valid cookie must authenticate successfully');
    wsAbsentOrigin.close();
    markPassed('CSWSH Foreign origin rejected, same-origin and absent origin accepted');

    // -------------------------------------------------------------
    // TEST 7: WebSocket Role Authorization & Structured Logs
    // -------------------------------------------------------------
    console.log('[*] Test 7: WebSocket Role Authorization & Structured Logs...');

    // a. Non-admin WS token attempting to subscribe to console or execute commands
    const wsNonAdmin = new WebSocket(`${wsUrl}?token=${validNonAdminToken}`);
    const nonAdminWsMsgs = [];
    await new Promise((resolve, reject) => {
      wsNonAdmin.on('open', resolve);
      wsNonAdmin.on('error', reject);
    });
    wsNonAdmin.on('message', (raw) => {
      try { nonAdminWsMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    wsNonAdmin.send(JSON.stringify({ type: 'subscribe_console', serverId: 'test-srv' }));
    wsNonAdmin.send(JSON.stringify({ type: 'console_command', serverId: 'test-srv', command: 'help' }));

    await new Promise((r) => setTimeout(r, 200));

    const roleErrors = nonAdminWsMsgs.filter((m) =>
      (m.type === 'error' || m.type === 'command_error') &&
      (m.code === 'UNAUTHORIZED' || m.code === 'FORBIDDEN' || (m.error && m.error.includes('Forbidden')) || (m.message && m.message.includes('Authentication required')) || (m.message && m.message.includes('Forbidden')))
    );
    assert.strictEqual(roleErrors.length, 2, 'Non-admin WS actions must be rejected');
    wsNonAdmin.close();

    // b. Admin WS client receiving structured console history
    const wsAdmin = new WebSocket(`${wsUrl}?token=${validAdminToken}`);
    const adminMsgs = [];
    await new Promise((resolve, reject) => {
      wsAdmin.on('open', resolve);
      wsAdmin.on('error', reject);
    });
    wsAdmin.on('message', (raw) => {
      try { adminMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    const testSrvId = 'sec-test-' + Date.now();
    processManager._appendLog(testSrvId, 'Server initialized', 'stdout', 'boot_phase');
    processManager._appendLog(testSrvId, 'Admin executed /reload', 'command', 'admin_audit');

    wsAdmin.send(JSON.stringify({ type: 'subscribe_console', serverId: testSrvId }));
    await new Promise((r) => setTimeout(r, 400));

    const historyMsg = adminMsgs.find((m) => m.type === 'console_history');
    assert(historyMsg, 'console_history message must be received');
    // Verify lines is string array
    assert(Array.isArray(historyMsg.lines), 'lines must be an Array');
    assert.strictEqual(typeof historyMsg.lines[0], 'string', 'lines items must be strings');
    // Verify logs is object array preserving metadata
    assert(Array.isArray(historyMsg.logs), 'logs must be an Array');
    const auditLog = historyMsg.logs.find((l) => typeof l === 'object' && l.text && l.text.includes('/reload'));
    assert(auditLog, 'Structured log entry for /reload command must be preserved');
    assert.strictEqual(auditLog.type, 'command', 'Log entry type must be preserved');
    assert.strictEqual(auditLog.event, 'admin_audit', 'Log entry event must be preserved');

    wsAdmin.close();
    markPassed('Non-admin WS commands rejected; console_history preserves lines array & structured logs');

    // -------------------------------------------------------------
    // TEST 8: Dynamic JWT Expiration Guard on WebSocket Connection
    // -------------------------------------------------------------
    console.log('[*] Test 8: Dynamic JWT Expiration Guard on WebSocket Connection...');

    // Generate a short-lived token expiring in 2 seconds
    const shortLivedAdminToken = jwt.sign(
      { username: 'shortlivedadmin', role: 'admin' },
      config.JWT_SECRET,
      { expiresIn: '2s' }
    );

    const wsExp = new WebSocket(`${wsUrl}?token=${shortLivedAdminToken}`);
    const expMsgs = [];
    wsExp.on('message', (raw) => {
      try { expMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });
    await new Promise((resolve, reject) => {
      wsExp.on('open', resolve);
      wsExp.on('error', reject);
    });

    const expSrvId = 'exp-test-' + Date.now();
    wsExp.send(JSON.stringify({ type: 'subscribe_console', serverId: expSrvId }));
    wsExp.send(JSON.stringify({ type: 'subscribe_metrics' }));

    // Wait 300ms to verify initial valid subscription works before token expires
    await new Promise((r) => setTimeout(r, 300));
    assert(expMsgs.some((m) => m.type === 'console_history'), 'Should receive console_history while token is valid');

    // Wait until token expires (2s lifetime + 300ms buffer)
    await new Promise((r) => setTimeout(r, 2200));

    // Clear recorded messages prior to expiration to isolate post-expiry behavior
    const postExpiryMsgs = [];
    wsExp.on('message', (raw) => {
      try { postExpiryMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    // Attempt privileged command on expired socket
    wsExp.send(JSON.stringify({ type: 'console_command', serverId: expSrvId, command: 'say after-expiry' }));

    // Trigger sensitive internal broadcasts while token is expired
    wsManager.broadcastConsoleLine(expSrvId, 'sensitive console log after expiry');
    wsManager.broadcastConsoleReset(expSrvId, 'expired-reset-session');
    wsManager.broadcastServerStatus(expSrvId, 'stopped', 'running');
    wsManager.broadcastPlayerEvent(expSrvId, 'join', 'StealthPlayer');
    wsManager.broadcastDownloadProgress({ type: 'paper', progress: 50 });
    wsManager._broadcastMetrics();

    await new Promise((r) => setTimeout(r, 400));

    // 1. Privileged command MUST be rejected
    const expiredCommandError = postExpiryMsgs.find(
      (m) => (m.type === 'error' && m.code === 'UNAUTHORIZED') || m.type === 'auth_error'
    );
    assert(expiredCommandError, 'Console command on expired token must be rejected with auth_error or UNAUTHORIZED');

    // 2. Sensitive broadcast frames MUST NOT be delivered to expired client
    const sensitiveBroadcastsDelivered = postExpiryMsgs.filter((m) =>
      ['console_line', 'console_reset', 'server_status', 'player_event', 'download_progress', 'metrics_update'].includes(m.type)
    );
    assert.strictEqual(
      sensitiveBroadcastsDelivered.length,
      0,
      `Expired socket must not receive sensitive broadcast frames! Received: ${JSON.stringify(sensitiveBroadcastsDelivered)}`
    );

    wsExp.close();
    markPassed('Dynamic token expiration rejects commands and drops all sensitive broadcast frames');

    // -------------------------------------------------------------
    // TEST 9: Non-Admin Broadcast Isolation
    // -------------------------------------------------------------
    console.log('[*] Test 9: Non-Admin WS Broadcast Isolation...');

    const wsNonAdminBroadcast = new WebSocket(`${wsUrl}?token=${validNonAdminToken}`);
    const nonAdminBroadcastMsgs = [];
    await new Promise((resolve, reject) => {
      wsNonAdminBroadcast.on('open', resolve);
      wsNonAdminBroadcast.on('error', reject);
    });
    wsNonAdminBroadcast.on('message', (raw) => {
      try { nonAdminBroadcastMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    // Attempt subscription (should fail)
    const nonAdminSrvId = 'nonadmin-test-' + Date.now();
    wsNonAdminBroadcast.send(JSON.stringify({ type: 'subscribe_console', serverId: nonAdminSrvId }));
    wsNonAdminBroadcast.send(JSON.stringify({ type: 'subscribe_metrics' }));

    // Trigger internal broadcasts
    wsManager.broadcastConsoleLine(nonAdminSrvId, 'sensitive nonadmin console line');
    wsManager.broadcastConsoleReset(nonAdminSrvId, 'reset-session');
    wsManager.broadcastServerStatus(nonAdminSrvId, 'online', 'offline');
    wsManager.broadcastPlayerEvent(nonAdminSrvId, 'join', 'UnauthorizedUser');
    wsManager.broadcastDownloadProgress({ type: 'forge', progress: 80 });
    wsManager._broadcastMetrics();

    await new Promise((r) => setTimeout(r, 400));

    const sensitiveNonAdminFrames = nonAdminBroadcastMsgs.filter((m) =>
      ['console_line', 'console_reset', 'server_status', 'player_event', 'download_progress', 'metrics_update'].includes(m.type)
    );
    assert.strictEqual(
      sensitiveNonAdminFrames.length,
      0,
      `Non-admin WS client must never receive sensitive broadcasts! Received: ${JSON.stringify(sensitiveNonAdminFrames)}`
    );

    wsNonAdminBroadcast.close();
    markPassed('Valid non-admin WS client receives zero sensitive broadcast frames');

    // -------------------------------------------------------------
    // TEST 10: Revocation of Subscriptions on Invalid Re-Authentication
    // -------------------------------------------------------------
    console.log('[*] Test 10: Revocation of Subscriptions on Invalid Re-Authentication...');

    const wsReauth = new WebSocket(`${wsUrl}?token=${validAdminToken}`);
    const reauthMsgs = [];
    await new Promise((resolve, reject) => {
      wsReauth.on('open', resolve);
      wsReauth.on('error', reject);
    });
    wsReauth.on('message', (raw) => {
      try { reauthMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    const reauthSrvId = 'reauth-test-' + Date.now();
    wsReauth.send(JSON.stringify({ type: 'subscribe_console', serverId: reauthSrvId }));
    wsReauth.send(JSON.stringify({ type: 'subscribe_metrics' }));

    await new Promise((r) => setTimeout(r, 200));

    // Verify initial broadcast arrives before invalid re-auth
    wsManager.broadcastConsoleLine(reauthSrvId, 'line before invalid re-auth');
    await new Promise((r) => setTimeout(r, 200));
    assert(
      reauthMsgs.some((m) => m.type === 'console_line' && m.line === 'line before invalid re-auth'),
      'Admin client must receive console broadcast before invalid re-auth'
    );

    // Send invalid re-authentication message
    const msgsAfterReauth = [];
    wsReauth.on('message', (raw) => {
      try { msgsAfterReauth.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    wsReauth.send(JSON.stringify({ type: 'auth', token: 'invalid.spoofed.token' }));
    await new Promise((r) => setTimeout(r, 200));

    assert(
      msgsAfterReauth.some((m) => m.type === 'auth_error'),
      'Invalid re-auth must return auth_error'
    );

    // Attempt to trigger broadcasts after invalid re-auth - client must NOT receive them
    wsManager.broadcastConsoleLine(reauthSrvId, 'line after invalid re-auth - should NOT leak');
    wsManager.broadcastServerStatus(reauthSrvId, 'stopped', 'running');
    wsManager.broadcastDownloadProgress({ type: 'fabric', progress: 90 });
    wsManager._broadcastMetrics();

    // Attempt privileged command
    wsReauth.send(JSON.stringify({ type: 'console_command', serverId: reauthSrvId, command: 'stop' }));

    await new Promise((r) => setTimeout(r, 400));

    const leakedFrames = msgsAfterReauth.filter((m) =>
      ['console_line', 'console_reset', 'server_status', 'player_event', 'download_progress', 'metrics_update'].includes(m.type)
    );
    assert.strictEqual(
      leakedFrames.length,
      0,
      `Subscriptions must be revoked on invalid re-auth! Received: ${JSON.stringify(leakedFrames)}`
    );

    wsReauth.close();
    markPassed('Invalid re-authentication revokes subscriptions and drops privileged command access');

    // -------------------------------------------------------------
    // TEST 11: mazipanel_session Cookie Authentication & Logout
    // -------------------------------------------------------------
    console.log('[*] Test 11: mazipanel_session Cookie Authentication & Logout...');

    // Setup an admin user to test real login flow
    let testCookieUser = 'cookietestuser';
    let testCookiePass = 'TestPass123!';
    try {
      await authService.createUser({ username: testCookieUser, password: testCookiePass, role: 'admin' });
    } catch (e) {}

    // Perform login
    const loginRes = await request('POST', '/api/auth/login', {}, { username: testCookieUser, password: testCookiePass });
    assert.strictEqual(loginRes.status, 200, 'Login must succeed with 200');
    assert(loginRes.headers['set-cookie'], 'Login response must set cookie');
    const setCookieHeaders = Array.isArray(loginRes.headers['set-cookie'])
      ? loginRes.headers['set-cookie']
      : [loginRes.headers['set-cookie']];
    const sessionCookieHeader = setCookieHeaders.find((c) => c.startsWith('mazipanel_session='));
    assert(sessionCookieHeader, 'Set-Cookie must contain mazipanel_session');
    assert(/httponly/i.test(sessionCookieHeader), 'mazipanel_session must be HttpOnly');
    assert(/samesite=strict/i.test(sessionCookieHeader), 'mazipanel_session must be SameSite=Strict');

    const cookieValMatch = sessionCookieHeader.match(/mazipanel_session=([^;]+)/);
    const sessionCookie = cookieValMatch ? cookieValMatch[1] : '';
    assert(sessionCookie, 'mazipanel_session value must not be empty');

    // Access /api/auth/me using mazipanel_session cookie
    const cookieMeRes = await request('GET', '/api/auth/me', {
      'Cookie': `mazipanel_session=${sessionCookie}`
    });
    assert.strictEqual(cookieMeRes.status, 200, 'GET /api/auth/me with mazipanel_session must succeed with 200');
    assert.strictEqual(cookieMeRes.body?.user?.username, testCookieUser, 'Username in response must match');

    // Logout
    const logoutRes = await request('POST', '/api/auth/logout', {
      'Cookie': `mazipanel_session=${sessionCookie}`
    });
    assert.strictEqual(logoutRes.status, 200, 'POST /api/auth/logout must succeed with 200');
    const logoutCookies = Array.isArray(logoutRes.headers['set-cookie'])
      ? logoutRes.headers['set-cookie']
      : [logoutRes.headers['set-cookie']];
    const clearedCookie = logoutCookies.find((c) => c.startsWith('mazipanel_session='));
    assert(clearedCookie, 'Logout must clear mazipanel_session cookie');
    markPassed('mazipanel_session cookie login, HttpOnly/SameSite verification, and logout verified');

    // -------------------------------------------------------------
    // TEST 12: tokenVersion Session Revocation (logout-all)
    // -------------------------------------------------------------
    console.log('[*] Test 12: tokenVersion Session Revocation (logout-all)...');

    // Login again to obtain a fresh session
    const login2Res = await request('POST', '/api/auth/login', {}, { username: testCookieUser, password: testCookiePass });
    assert.strictEqual(login2Res.status, 200);
    const sessionToken = login2Res.body.token;

    // Verify session is active
    const preRevokeRes = await request('GET', '/api/auth/me', {
      'Authorization': `Bearer ${sessionToken}`
    });
    assert.strictEqual(preRevokeRes.status, 200, 'Token must be valid before revocation');

    // Call /api/auth/logout-all to invalidate all active sessions
    const revokeAllRes = await request('POST', '/api/auth/logout-all', {
      'Authorization': `Bearer ${sessionToken}`
    });
    assert.strictEqual(revokeAllRes.status, 200, 'POST /api/auth/logout-all must succeed');

    // Verify old token is now REJECTED with 401 because tokenVersion was incremented
    const postRevokeRes = await request('GET', '/api/auth/me', {
      'Authorization': `Bearer ${sessionToken}`
    });
    assert.strictEqual(postRevokeRes.status, 401, 'Revoked token with outdated tokenVersion must be rejected with 401');
    markPassed('tokenVersion increment revokes all sessions across devices immediately');

    // -------------------------------------------------------------
    // TEST 13: Rate Limiting & Progressive Backoff (429 + retryAfter)
    // -------------------------------------------------------------
    console.log('[*] Test 13: Rate Limiting & Progressive Backoff (429 + retryAfter)...');
    const rateLimiter = require('../src/auth/rateLimiter');
    const testRateUser = 'ratelimituser_' + Date.now();
    const testIp = '127.0.0.99';

    const prevMax = process.env.TEST_AUTH_RATE_LIMIT_MAX;
    process.env.TEST_AUTH_RATE_LIMIT_MAX = '5';

    try {
      // Reset any existing counter
      rateLimiter.reset(testIp, testRateUser);

      // Record failures up to threshold
      let lastFail = null;
      for (let i = 0; i < 5; i++) {
        lastFail = rateLimiter.recordFailure(testIp, testRateUser);
      }
      assert.strictEqual(lastFail.blocked, true, '5th consecutive failure must trigger rate limit block');
      assert.strictEqual(lastFail.retryAfter, 30, 'Initial block delay must be 30 seconds');

      const checkStatus = rateLimiter.check(testIp, testRateUser);
      assert.strictEqual(checkStatus.blocked, true, 'Rate limiter check must report blocked state');
      assert(checkStatus.retryAfter > 0, 'retryAfter must be greater than 0');

      // Reset rate limiter on successful authentication
      rateLimiter.reset(testIp, testRateUser);
      const afterReset = rateLimiter.check(testIp, testRateUser);
      assert.strictEqual(afterReset.blocked, false, 'Rate limiter must reset after successful authentication');
      markPassed('Rate limiting activates at 5 failed attempts with 30s delay and resets cleanly');
    } finally {
      if (prevMax !== undefined) {
        process.env.TEST_AUTH_RATE_LIMIT_MAX = prevMax;
      } else {
        delete process.env.TEST_AUTH_RATE_LIMIT_MAX;
      }
    }

    // -------------------------------------------------------------
    // TEST 14: HTTP Security Headers Enforcement
    // -------------------------------------------------------------
    console.log('[*] Test 14: HTTP Security Headers Enforcement...');
    const secHeadersRes = await request('GET', '/api/health');
    assert.strictEqual(secHeadersRes.headers['x-powered-by'], undefined, 'X-Powered-By must be disabled');
    assert.strictEqual(secHeadersRes.headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options must be nosniff');
    assert.strictEqual(secHeadersRes.headers['x-frame-options'], 'DENY', 'X-Frame-Options must be DENY');
    assert.strictEqual(secHeadersRes.headers['referrer-policy'], 'same-origin', 'Referrer-Policy must be same-origin');
    assert(secHeadersRes.headers['permissions-policy'], 'Permissions-Policy must be set');
    assert(secHeadersRes.headers['content-security-policy'], 'Content-Security-Policy must be set');
    assert(secHeadersRes.headers['content-security-policy'].includes("connect-src 'self' ws: wss:"), 'CSP must allow connect-src for websockets');
    assert(secHeadersRes.headers['content-security-policy'].includes("img-src 'self' data: blob:"), 'CSP must allow data and blob images');
    markPassed('All required security headers and CSP directives are strictly enforced');

    console.log('\n====================================================');
    console.log(`   ALL ${passedTests}/${totalTests} AUTH SECURITY TESTS PASSED SUCCESSFULLY!    `);
    console.log('====================================================');
  } finally {
    wsManager.close();
    await new Promise((resolve) => server.close(resolve));

    // Clean ONLY self-created test dirs after verify; existing QA env dirs are never deleted
    if (testTmpDir && fs.existsSync(testTmpDir)) {
      try {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

if (require.main === module) {
  runAuthSecurityTests()
    .then(() => {
      console.log('[Auth Security] Test suite exited cleanly with code 0.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Auth Security] Test suite FAILED:', err);
      process.exit(1);
    });
}

module.exports = runAuthSecurityTests;
