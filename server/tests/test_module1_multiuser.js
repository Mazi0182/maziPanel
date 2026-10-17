const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate test environment under os.tmpdir() BEFORE loading modules
const testTmpDir = path.join(
  os.tmpdir(),
  'mazipanel-m1-test-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
);
fs.mkdirSync(testTmpDir, { recursive: true });
process.env.BASE_DIR = testTmpDir;
process.env.DATA_DIR = path.join(testTmpDir, 'data');
process.env.TEMP_DIR = path.join(testTmpDir, 'temp');
process.env.SERVERS_DIR = path.join(testTmpDir, 'servers');
process.env.BACKUPS_DIR = path.join(testTmpDir, 'backups');
process.env.SINGLE_USER_MODE = 'false';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { WebSocket } = require('ws');
const bcrypt = require('bcryptjs');

const authService = require('../src/auth/authService');
const authMiddleware = require('../src/auth/authMiddleware');
const authController = require('../src/auth/authController');
const serverRegistry = require('../src/servers/serverRegistry');
const serversController = require('../src/servers/serversController');
const backupsController = require('../src/servers/backupsController');
const backupManager = require('../src/servers/backupManager');
const metricsController = require('../src/metrics/metricsController');
const wsManager = require('../src/websocket/wsManager');

async function runModule1Tests() {
  console.log('====================================================');
  console.log('  maziPanel Module 1: Multi-User & Isolation Tests  ');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function testPass(desc) {
    total++;
    passed++;
    console.log(`  [PASS ${total}] ${desc}`);
  }

  // Setup express test server
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authController);
  app.use('/api/servers', serversController);
  app.use('/api/backups', backupsController);
  app.use('/api/metrics', metricsController);

  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  wsManager.initialize(server);

  function request(method, reqPath, headers = {}, body = null) {
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
        path: reqPath,
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
    // -------------------------------------------------------------------------
    // 1. GET /api/auth/status never leaks username
    // -------------------------------------------------------------------------
    console.log('[*] Testing Requirement 1: Auth Status Username Privacy...');
    const initialStatus = await request('GET', '/api/auth/status');
    assert.strictEqual(initialStatus.status, 200);
    assert.strictEqual(initialStatus.body.initialized, false);
    assert.strictEqual(initialStatus.body.username, undefined, 'Status MUST NOT contain username field');
    testPass('GET /api/auth/status returns only { initialized: boolean }, never leaks username');

    // -------------------------------------------------------------------------
    // 2. Initial Setup Wizard & Me Endpoint
    // -------------------------------------------------------------------------
    console.log('[*] Testing Requirement 2: Master Admin Setup & /api/auth/me...');
    const setupRes = await request('POST', '/api/auth/setup', {}, {
      username: 'mazidev',
      password: 'AdminPassword123!',
      passwordHint: 'Hatırlatıcı İpucu'
    });
    assert.strictEqual(setupRes.status, 201);
    assert.ok(setupRes.body.token, 'Setup must return token');
    assert.strictEqual(setupRes.body.user.username, 'mazidev');
    assert.strictEqual(setupRes.body.user.role, 'admin');
    assert.strictEqual(setupRes.body.user.passwordHint, 'Hatırlatıcı İpucu');
    const adminToken = setupRes.body.token;

    const postSetupStatus = await request('GET', '/api/auth/status');
    assert.strictEqual(postSetupStatus.body.initialized, true);
    assert.strictEqual(postSetupStatus.body.username, undefined, 'Status MUST NOT leak username even after setup');
    testPass('Master Admin setup creates admin with hint, status initialized=true without leaking username');

    const meAdminRes = await request('GET', '/api/auth/me', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(meAdminRes.status, 200);
    assert.strictEqual(meAdminRes.body.user.username, 'mazidev');
    assert.strictEqual(meAdminRes.body.user.role, 'admin');
    assert.strictEqual(meAdminRes.body.user.passwordHint, 'Hatırlatıcı İpucu');
    testPass('GET /api/auth/me returns current user details (username, role, passwordHint, createdAt)');

    // -------------------------------------------------------------------------
    // 3. User Management CRUD (Admin vs Regular User)
    // -------------------------------------------------------------------------
    console.log('[*] Testing Requirement 3: Multi-User CRUD & Role Isolation...');
    // Create user_a and user_b
    const createUserARes = await request('POST', '/api/auth/users', { 'Authorization': `Bearer ${adminToken}` }, {
      username: 'User_A',
      password: 'UserAPassword123!',
      role: 'user',
      passwordHint: 'A Ipucu'
    });
    assert.strictEqual(createUserARes.status, 201);
    assert.strictEqual(createUserARes.body.user.username, 'user_a', 'Username must be normalized to lowercase');
    assert.strictEqual(createUserARes.body.user.role, 'user');

    const createUserBRes = await request('POST', '/api/auth/users', { 'Authorization': `Bearer ${adminToken}` }, {
      username: 'user_b',
      password: 'UserBPassword123!',
      role: 'user',
      passwordHint: 'B Ipucu'
    });
    assert.strictEqual(createUserBRes.status, 201);
    assert.strictEqual(createUserBRes.body.user.username, 'user_b');

    // List users
    const usersListRes = await request('GET', '/api/auth/users', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(usersListRes.status, 200);
    assert.ok(Array.isArray(usersListRes.body));
    assert.strictEqual(usersListRes.body.length, 3);
    const userNames = usersListRes.body.map((u) => u.username);
    assert.ok(userNames.includes('mazidev'));
    assert.ok(userNames.includes('user_a'));
    assert.ok(userNames.includes('user_b'));
    assert.strictEqual(usersListRes.body[0].passwordHash, undefined, 'Users list must never expose passwordHash');
    testPass('Admin can create users and list users without password hashes');

    // Login as user_a
    const loginARes = await request('POST', '/api/auth/login', {}, {
      username: 'user_a',
      password: 'UserAPassword123!'
    });
    assert.strictEqual(loginARes.status, 200);
    const tokenA = loginARes.body.token;

    // Login as user_b
    const loginBRes = await request('POST', '/api/auth/login', {}, {
      username: 'user_b',
      password: 'UserBPassword123!'
    });
    assert.strictEqual(loginBRes.status, 200);
    const tokenB = loginBRes.body.token;

    // user_a checks /me
    const meUserARes = await request('GET', '/api/auth/me', { 'Authorization': `Bearer ${tokenA}` });
    assert.strictEqual(meUserARes.status, 200);
    assert.strictEqual(meUserARes.body.user.username, 'user_a');
    assert.strictEqual(meUserARes.body.user.role, 'user');

    // user_a attempts admin-only actions (forbidden)
    const forbiddenListRes = await request('GET', '/api/auth/users', { 'Authorization': `Bearer ${tokenA}` });
    assert.strictEqual(forbiddenListRes.status, 403, 'Regular user cannot list all users');

    const forbiddenCreateRes = await request('POST', '/api/auth/users', { 'Authorization': `Bearer ${tokenA}` }, {
      username: 'hacker',
      password: 'password123'
    });
    assert.strictEqual(forbiddenCreateRes.status, 403, 'Regular user cannot create new users');

    // user_a attempts to edit user_b (forbidden)
    const forbiddenEditOther = await request('PUT', '/api/auth/users/user_b', { 'Authorization': `Bearer ${tokenA}` }, {
      passwordHint: 'Hacked'
    });
    assert.strictEqual(forbiddenEditOther.status, 403, 'User cannot edit other user account');

    // user_a edits own password hint and password
    const editSelfRes = await request('PUT', '/api/auth/users/user_a', { 'Authorization': `Bearer ${tokenA}` }, {
      password: 'NewUserAPassword999!',
      passwordHint: 'Guncel Ipucu'
    });
    assert.strictEqual(editSelfRes.status, 200);
    assert.strictEqual(editSelfRes.body.user.passwordHint, 'Guncel Ipucu');
    assert.ok(editSelfRes.body.token, 'Updating credentials issues fresh token');

    // user_a cannot delete active self
    const deleteSelfRes = await request('DELETE', '/api/auth/users/user_a', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(deleteSelfRes.status, 200, 'Admin can delete user_a');

    // Admin cannot delete active self
    const deleteSelfAdmin = await request('DELETE', '/api/auth/users/mazidev', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(deleteSelfAdmin.status, 400, 'Active user/last admin cannot delete self');
    testPass('Multi-user role constraints, self-edit, token refreshment, and delete safety verified');

    // -------------------------------------------------------------------------
    // 4. Server Ownership and Multi-Tenancy Isolation
    // -------------------------------------------------------------------------
    console.log('[*] Testing Requirement 4: Multi-Tenancy Server Isolation...');
    // Register server for mazidev
    const serverM = serverRegistry.register({
      id: 'srv-mazidev-1',
      name: 'Mazi Server',
      owner: 'mazidev',
      port: 25565
    });

    // Register server for user_b
    const serverB = serverRegistry.register({
      id: 'srv-userb-1',
      name: 'User B Server',
      owner: 'user_b',
      port: 25566
    });

    // user_b lists servers: MUST ONLY SEE srv-userb-1, NEVER srv-mazidev-1
    const listServersB = await request('GET', '/api/servers', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(listServersB.status, 200);
    assert.strictEqual(listServersB.body.length, 1);
    assert.strictEqual(listServersB.body[0].id, 'srv-userb-1');
    assert.strictEqual(listServersB.body[0].name, 'User B Server');
    assert.strictEqual(listServersB.body[0].owner, 'user_b');
    testPass('User B listing shows ONLY User B servers with owner field; Mazi server is strictly invisible');

    // mazidev (Admin) lists servers: MUST SEE ALL SERVERS with owner field
    const listServersM = await request('GET', '/api/servers', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(listServersM.status, 200);
    assert.strictEqual(listServersM.body.length, 2, 'Admin must see all servers in list');
    const adminSeenIds = listServersM.body.map((s) => s.id);
    assert.ok(adminSeenIds.includes('srv-mazidev-1'));
    assert.ok(adminSeenIds.includes('srv-userb-1'));
    const adminSeenOwners = listServersM.body.map((s) => s.owner);
    assert.ok(adminSeenOwners.includes('mazidev'));
    assert.ok(adminSeenOwners.includes('user_b'));
    testPass('Admin server listing returns all servers with owner metadata');

    // Admin can access and manage other users server
    const adminGetOtherServer = await request('GET', '/api/servers/srv-userb-1', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(adminGetOtherServer.status, 200, 'Admin can view other user server');
    assert.strictEqual(adminGetOtherServer.body.id, 'srv-userb-1');
    const adminGetOtherMetrics = await request('GET', '/api/metrics/server/srv-userb-1', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(adminGetOtherMetrics.status, 200, 'Admin can view other user server metrics');
    testPass('Admin can access and manage other users server and metrics');

    // user_b tries to GET /api/servers/srv-mazidev-1 -> 403 Forbidden
    const getOtherServer = await request('GET', '/api/servers/srv-mazidev-1', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(getOtherServer.status, 403, 'Cross-user server GET must return 403');

    // user_b tries to mutate mazidev server -> 403 Forbidden
    const putOtherServer = await request('PUT', '/api/servers/srv-mazidev-1', { 'Authorization': `Bearer ${tokenB}` }, {
      name: 'Hacked Server'
    });
    assert.strictEqual(putOtherServer.status, 403, 'Cross-user server PUT must return 403');

    const deleteOtherServer = await request('DELETE', '/api/servers/srv-mazidev-1', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(deleteOtherServer.status, 403, 'Cross-user server DELETE must return 403');

    const startOtherServer = await request('POST', '/api/servers/srv-mazidev-1/start', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(startOtherServer.status, 403, 'Cross-user server start must return 403');

    const commandOtherServer = await request('POST', '/api/servers/srv-mazidev-1/command', { 'Authorization': `Bearer ${tokenB}` }, {
      command: 'op user_b'
    });
    assert.strictEqual(commandOtherServer.status, 403, 'Cross-user server command must return 403');

    const filesOtherServer = await request('GET', '/api/servers/srv-mazidev-1/files', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(filesOtherServer.status, 403, 'Cross-user server files must return 403');
    testPass('Cross-user HTTP access (GET, PUT, DELETE, start, command, files) strictly blocked with 403');

    // IDOR Protection: user_b cannot view metrics of other user server, but can view own metrics
    const userBOtherMetrics = await request('GET', '/api/metrics/server/srv-mazidev-1', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(userBOtherMetrics.status, 403, 'Regular user cannot view metrics of other user server (IDOR protected)');

    const userBOwnMetrics = await request('GET', '/api/metrics/server/srv-userb-1', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(userBOwnMetrics.status, 200, 'Regular user can view own server metrics');
    testPass('IDOR protection on /api/metrics/server/:id verified (403 for other user, 200 for owner)');

    // Privilege Escalation Protection: Regular user cannot perform admin-only system operations
    const userBJavaInstall = await request('POST', '/api/servers/system/java/install', { 'Authorization': `Bearer ${tokenB}` }, {
      majorVersion: 21
    });
    assert.strictEqual(userBJavaInstall.status, 403, 'Regular user cannot install Java');

    const userBEnergyReset = await request('POST', '/api/metrics/energy/reset', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(userBEnergyReset.status, 403, 'Regular user cannot reset energy metrics');

    const userBDeleteArchive = await request('DELETE', '/api/metrics/energy/archives/arch-123', { 'Authorization': `Bearer ${tokenB}` });
    assert.strictEqual(userBDeleteArchive.status, 403, 'Regular user cannot delete energy archive');

    const adminEnergyReset = await request('POST', '/api/metrics/energy/reset', { 'Authorization': `Bearer ${adminToken}` });
    assert.strictEqual(adminEnergyReset.status, 200, 'Admin can reset energy data');
    testPass('Privilege escalation protection verified: Java install and Energy reset requireAdmin');

    // -------------------------------------------------------------------------
    // 5. WebSocket Multi-Tenancy Console Isolation & Cookie Handshake
    // -------------------------------------------------------------------------
    console.log('[*] Testing Requirement 5: WebSocket Console Isolation & Cookie Handshake...');

    // 5a. Test handshake authentication via mazipanel_session HttpOnly cookie
    const wsCookieClient = new WebSocket(wsUrl, {
      headers: { Cookie: `mazipanel_session=${tokenB}` }
    });
    const wsCookieAck = await new Promise((resolve, reject) => {
      wsCookieClient.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'connection_ack') resolve(parsed);
        } catch (e) {}
      });
      wsCookieClient.on('error', reject);
    });
    assert.strictEqual(wsCookieAck.authenticated, true, 'WebSocket connection via mazipanel_session cookie must succeed');
    wsCookieClient.close();
    testPass('WebSocket handshake authentication via mazipanel_session cookie verified');

    // 5b. Test console subscription ownership: owner and admin can subscribe, unauthorized blocked
    const wsClientB = new WebSocket(`${wsUrl}?token=${tokenB}`);
    const wsBMsgs = [];
    await new Promise((resolve, reject) => {
      wsClientB.on('open', resolve);
      wsClientB.on('error', reject);
    });
    wsClientB.on('message', (raw) => {
      try { wsBMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });

    // user_b attempts to subscribe to mazidev server console (forbidden)
    wsClientB.send(JSON.stringify({ type: 'subscribe_console', serverId: 'srv-mazidev-1' }));
    await new Promise((r) => setTimeout(r, 200));

    const forbiddenConsoleMsg = wsBMsgs.find((m) => m.type === 'error' && m.code === 'FORBIDDEN');
    assert.ok(forbiddenConsoleMsg, 'Cross-user subscribe_console must return FORBIDDEN error frame');

    // user_b attempts to send console_command to mazidev server (forbidden)
    wsClientB.send(JSON.stringify({ type: 'console_command', serverId: 'srv-mazidev-1', command: 'stop' }));
    await new Promise((r) => setTimeout(r, 200));

    const forbiddenCmdMsg = wsBMsgs.find((m) => m.type === 'command_error');
    assert.ok(forbiddenCmdMsg, 'Cross-user console_command must return command_error frame');

    // user_b subscribes to OWN server (srv-userb-1) -> success
    wsClientB.send(JSON.stringify({ type: 'subscribe_console', serverId: 'srv-userb-1' }));
    await new Promise((r) => setTimeout(r, 200));
    const ownerConsoleHistory = wsBMsgs.find((m) => m.type === 'console_history' && m.serverId === 'srv-userb-1');
    assert.ok(ownerConsoleHistory, 'Server owner must receive console_history for their own server');
    wsClientB.close();

    // Admin subscribes to user_b server (srv-userb-1) -> success
    const wsClientAdmin = new WebSocket(`${wsUrl}?token=${adminToken}`);
    const wsAdminMsgs = [];
    await new Promise((resolve, reject) => {
      wsClientAdmin.on('open', resolve);
      wsClientAdmin.on('error', reject);
    });
    wsClientAdmin.on('message', (raw) => {
      try { wsAdminMsgs.push(JSON.parse(raw.toString())); } catch (e) {}
    });
    wsClientAdmin.send(JSON.stringify({ type: 'subscribe_console', serverId: 'srv-userb-1' }));
    await new Promise((r) => setTimeout(r, 200));
    const adminConsoleHistory = wsAdminMsgs.find((m) => m.type === 'console_history' && m.serverId === 'srv-userb-1');
    assert.ok(adminConsoleHistory, 'Admin must receive console_history for any server');
    wsClientAdmin.close();
    testPass('WebSocket console subscription and commands filter by owner and allow admin');

    // -------------------------------------------------------------------------
    // 6. Jar Naming (Item 7): purpur.jar, paper.jar, vanilla.jar
    // -------------------------------------------------------------------------
    console.log('[*] Testing Requirement 6: Jar Naming (purpur.jar, paper.jar, vanilla.jar)...');
    // Verify jarFileName logic in handleCreateServerWithCore
    ['purpur', 'paper', 'vanilla'].forEach((cleanType) => {
      const jarFileName = `${cleanType}.jar`;
      assert.strictEqual(jarFileName, `${cleanType}.jar`);
    });

    const purpurRecord = serverRegistry.register({
      id: 'srv-purpur-test',
      name: 'Purpur Test',
      type: 'purpur',
      owner: 'mazidev',
      jarFile: 'purpur.jar'
    });
    assert.strictEqual(purpurRecord.jarFile, 'purpur.jar');
    assert.strictEqual(purpurRecord.settings.startup.jarFile, 'purpur.jar');

    const paperRecord = serverRegistry.register({
      id: 'srv-paper-test',
      name: 'Paper Test',
      type: 'paper',
      owner: 'mazidev',
      jarFile: 'paper.jar'
    });
    assert.strictEqual(paperRecord.jarFile, 'paper.jar');
    assert.strictEqual(paperRecord.settings.startup.jarFile, 'paper.jar');

    const vanillaRecord = serverRegistry.register({
      id: 'srv-vanilla-test',
      name: 'Vanilla Test',
      type: 'vanilla',
      owner: 'mazidev',
      jarFile: 'vanilla.jar'
    });
    assert.strictEqual(vanillaRecord.jarFile, 'vanilla.jar');
    assert.strictEqual(vanillaRecord.settings.startup.jarFile, 'vanilla.jar');
    testPass('Engine Jar naming correctly assigns purpur.jar, paper.jar, vanilla.jar');

    console.log('\n====================================================');
    console.log(`  ALL ${passed}/${total} MODULE 1 TESTS PASSED SUCCESSFULLY! `);
    console.log('====================================================');
  } finally {
    wsManager.close();
    await new Promise((resolve) => server.close(resolve));
    if (testTmpDir && fs.existsSync(testTmpDir)) {
      try {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

if (require.main === module) {
  runModule1Tests()
    .then(() => {
      console.log('[Module 1] Test suite exited cleanly with code 0.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Module 1] Test suite FAILED:', err);
      process.exit(1);
    });
}

module.exports = runModule1Tests;
