const assert = require('assert');
const authService = require('../src/auth/authService');

const PORT = process.env.TEST_PORT || process.env.PORT || '8080';
const HOST = process.env.TEST_HOST || '127.0.0.1';
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;
const WS_URL = process.env.WS_URL || `ws://${HOST}:${PORT}/ws`;

async function testLive() {
  const token = authService.generateToken({ username: 'masteradmin', role: 'admin' });
  const headers = { Authorization: `Bearer ${token}` };

  console.log(`Testing live HTTP service on port ${PORT}...`);

  // 1. GET /api/servers
  const srvRes = await fetch(`${BASE_URL}/api/servers`, { headers });
  assert.strictEqual(srvRes.status, 200, `GET /api/servers failed with HTTP ${srvRes.status}`);
  const srvList = await srvRes.json();
  assert(Array.isArray(srvList), 'GET /api/servers must return an array');
  console.log('[+] Servers retrieved:', srvList.length);
  assert(srvList.length > 0, 'No servers found in registry to test. Expected at least one fixture server.');

  const s = srvList[0];
  assert(s && typeof s === 'object', 'Server entry must be an object');
  assert(s.id, 'Server entry must have an id');
  assert(s.runtime, 'Server entry must contain runtime object');
  assert.strictEqual(typeof s.runtime.status, 'string', 'Runtime status must be a string');
  assert.strictEqual(typeof s.runtime.memoryMB, 'number', 'Runtime memoryMB must be a number');
  assert(s.runtime.allocatedFormatted, 'Runtime must have allocatedFormatted');
  console.log('[+] Server runtime object:', s.runtime);
  console.log(`    - Memory RSS: ${s.runtime.memoryMB} MB (${s.runtime.memoryBytes} bytes)`);
  console.log(`    - Allocated: ${s.runtime.allocatedMB} MB (${s.runtime.allocatedFormatted})`);

  // 2. GET /api/servers/:id/files
  const filesRes = await fetch(`${BASE_URL}/api/servers/${s.id}/files`, { headers });
  assert.strictEqual(filesRes.status, 200, `GET /api/servers/${s.id}/files failed with HTTP ${filesRes.status}`);
  const files = await filesRes.json();
  const fileEntries = Array.isArray(files) ? files : (files.entries || []);
  assert(Array.isArray(fileEntries), 'Files endpoint must return an array of entries');
  console.log('[+] Files endpoint Array check:', Array.isArray(fileEntries));
  console.log('[+] Files count:', fileEntries.length);

  // 3. GET /api/servers/:id/properties
  const propsRes = await fetch(`${BASE_URL}/api/servers/${s.id}/properties`, { headers });
  assert.strictEqual(propsRes.status, 200, `GET /api/servers/${s.id}/properties failed with HTTP ${propsRes.status}`);
  const props = await propsRes.json();
  assert(props && typeof props === 'object', 'Properties endpoint must return an object');
  console.log('[+] Properties retrieved:');
  console.log('    - MOTD:', props.motd);
  console.log('    - Port:', props.serverPort);
  console.log('    - Max Players:', props.maxPlayers);
  console.log('    - Difficulty:', props.difficulty);
  console.log('    - Gamemode:', props.gamemode);
  console.log('    - PvP:', props.pvp);
  console.log('    - Whitelist:', props.whiteList);
  console.log('    - Online Mode:', props.onlineMode);

  // 4. GET /api/servers/:id/icon
  const iconRes = await fetch(`${BASE_URL}/api/servers/${s.id}/icon`, { headers });
  assert([200, 404].includes(iconRes.status), `Unexpected icon HTTP status: ${iconRes.status}`);
  console.log('[+] Icon status:', iconRes.status, 'Content-Type:', iconRes.headers.get('content-type'));

  // 5. Test WebSocket ping-pong on live daemon
  const { WebSocket } = require('ws');
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let pongOk = false;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.event === 'pong') {
        pongOk = true;
        const latency = Date.now() - msg.timestamp;
        console.log(`[+] Live WebSocket Pong received! Latency: ${latency}ms (serverTime: ${msg.serverTime})`);
      }
    } catch {}
  });

  const pingTime = Date.now();
  ws.send(JSON.stringify({ action: 'ping', timestamp: pingTime }));

  await new Promise((resolve) => setTimeout(resolve, 300));
  ws.close();

  assert(pongOk, 'Live WebSocket Pong was not received');
  console.log('[+] ALL LIVE CHECKS PASSED SUCCESSFULLY!');
}

testLive().catch((e) => {
  console.error('[!] Test failed:', e);
  process.exit(1);
});
