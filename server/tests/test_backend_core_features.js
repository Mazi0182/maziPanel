const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocket } = require('ws');

const config = require('../config');
const serverRegistry = require('../src/servers/serverRegistry');
const processManager = require('../src/servers/processManager');
const fileManager = require('../src/servers/fileManager');
const metricsService = require('../src/metrics/metricsService');

async function runTests() {
  console.log('========================================================');
  console.log('       Backend Core Engineering Verification Suite      ');
  console.log('========================================================');

  // 1. Create a dummy test server in registry
  const testId = 'test-core-' + Date.now().toString(36);
  const testDir = path.join(config.SERVERS_DIR || path.join(__dirname, '../temp'), testId);
  fs.mkdirSync(testDir, { recursive: true });

  // Create dummy server.properties
  fs.writeFileSync(path.join(testDir, 'server.properties'), [
    '#Minecraft server properties',
    'motd=Initial Test MOTD',
    'server-port=25599',
    'max-players=25',
    'difficulty=hard',
    'gamemode=survival',
    'pvp=true',
    'white-list=false',
    'online-mode=true',
    'view-distance=12',
    'simulation-distance=8',
    'spawn-protection=0',
    'allow-flight=true',
    'level-name=world_nether',
    'level-seed=123456789',
    'enable-command-block=true',
    'spawn-animals=true',
    'spawn-monsters=true',
    'spawn-npcs=true'
  ].join('\n') + '\n', 'utf8');

  // Create dummy files
  fs.writeFileSync(path.join(testDir, 'eula.txt'), 'eula=true\n', 'utf8');

  const serverRecord = serverRegistry.register({
    id: testId,
    name: 'Backend Core Test',
    directory: testDir,
    jarFile: 'server.jar',
    minRam: '1G',
    maxRam: '2G',
    port: 25599
  });

  try {
    // -----------------------------------------------------------------
    // TEST 1: File Manager Array Response & Compatibility
    // -----------------------------------------------------------------
    console.log('[*] Test 1: File Manager listFiles format');
    const filesList = fileManager.listFiles(testId, '');
    assert(Array.isArray(filesList), 'listFiles must return an Array');
    assert(Array.isArray(filesList.entries), 'listFiles.entries must also exist and be an Array');
    assert.strictEqual(typeof filesList.currentPath, 'string', 'filesList.currentPath must exist');
    assert(filesList.length >= 2, 'Must contain at least eula.txt and server.properties');
    console.log('    PASS: listFiles is an Array with attached entries/currentPath properties');

    // -----------------------------------------------------------------
    // TEST 2: Comprehensive server.properties API
    // -----------------------------------------------------------------
    console.log('[*] Test 2: Comprehensive server.properties get and save');
    const props = fileManager.getServerProperties(testId);
    assert.strictEqual(props.motd, 'Initial Test MOTD');
    assert.strictEqual(props.serverPort, 25599);
    assert.strictEqual(props.maxPlayers, 25);
    assert.strictEqual(props.difficulty, 'hard');
    assert.strictEqual(props.gamemode, 'survival');
    assert.strictEqual(props.pvp, true);
    assert.strictEqual(props.whiteList, false);
    assert.strictEqual(props.onlineMode, true);
    assert.strictEqual(props.viewDistance, 12);
    assert.strictEqual(props.simulationDistance, 8);
    assert.strictEqual(props.spawnProtection, 0);
    assert.strictEqual(props.allowFlight, true);
    assert.strictEqual(props.levelName, 'world_nether');
    assert.strictEqual(props.levelSeed, '123456789');
    assert.strictEqual(props.enableCommandBlock, true);
    assert.strictEqual(props.spawnAnimals, true);
    assert.strictEqual(props.spawnMonsters, true);
    assert.strictEqual(props.spawnNpcs, true);
    console.log('    PASS: All 18 Minecraft parameters read and parsed with correct types');

    // Update properties
    const updatedProps = fileManager.saveServerProperties(testId, {
      motd: 'Updated Mazi MOTD',
      difficulty: 'normal',
      pvp: false,
      maxPlayers: 100,
      'view-distance': 16,
      'server-port': 25590
    });
    assert.strictEqual(updatedProps.motd, 'Updated Mazi MOTD');
    assert.strictEqual(updatedProps.difficulty, 'normal');
    assert.strictEqual(updatedProps.pvp, false);
    assert.strictEqual(updatedProps.maxPlayers, 100);
    assert.strictEqual(updatedProps.viewDistance, 16);
    assert.strictEqual(updatedProps.serverPort, 25590);

    // Verify registry updated port
    const regCheck = serverRegistry.getById(testId);
    assert.strictEqual(regCheck.port, 25590);
    console.log('    PASS: server.properties successfully updated and port synced to registry');

    // -----------------------------------------------------------------
    // TEST 3: Process Memory vs Host Memory
    // -----------------------------------------------------------------
    console.log('[*] Test 3: Process RSS Memory vs Host System Memory');
    const offlineStatus = processManager.getStatus(testId);
    assert.strictEqual(offlineStatus.status, 'offline');
    assert.strictEqual(offlineStatus.memoryBytes, 0, 'Offline memoryBytes must be 0');
    assert.strictEqual(offlineStatus.memoryMB, 0, 'Offline memoryMB must be 0');
    assert.strictEqual(offlineStatus.allocatedMB, 2048, 'Allocated MB from 2G should be 2048');
    assert.strictEqual(offlineStatus.allocatedFormatted, '2 GB', 'Allocated formatted should be 2 GB');

    const offlineMetrics = metricsService.getServerMetrics(testId);
    assert.strictEqual(offlineMetrics.memoryBytes, 0);
    assert.strictEqual(offlineMetrics.memoryMB, 0);
    assert.strictEqual(offlineMetrics.allocatedMB, 2048);
    assert.strictEqual(offlineMetrics.allocatedFormatted, '2 GB');
    console.log('    PASS: Offline status reports exactly 0 MB process memory and 2 GB allocated');

    // Test with current node process PID to simulate running Java process
    const currentPid = process.pid;
    const testRss = processManager._getPidRssBytes(currentPid);
    assert(testRss > 0, 'PID RSS lookup must return positive byte value for running process');
    console.log(`    PASS: Real process RSS measurement succeeded: ${Math.round(testRss / 1024 / 1024)} MB`);

    // -----------------------------------------------------------------
    // TEST 4: WebSocket Real Ping / Pong Latency & Console History
    // -----------------------------------------------------------------
    console.log('[*] Test 4: WebSocket Ping/Pong Latency and Console Event Broadcasting');
    const wsManager = require('../src/websocket/wsManager');
    
    // Start temporary HTTP server to attach WebSocket
    const tempHttp = http.createServer();
    await new Promise((res) => tempHttp.listen(0, '127.0.0.1', res));
    const assignedPort = tempHttp.address().port;
    wsManager.initialize(tempHttp);

    const wsClient = new WebSocket(`ws://127.0.0.1:${assignedPort}/ws`);

    await new Promise((resolve, reject) => {
      wsClient.on('open', resolve);
      wsClient.on('error', reject);
    });

    // Test ping pong
    const pingSent = Date.now();
    wsClient.send(JSON.stringify({ action: 'ping', timestamp: pingSent }));

    let pongReceived = false;
    let consoleHistoryReceived = false;
    let consoleLineReceived = false;

    // Add some logs to ring buffer
    processManager._appendLog(testId, '[12:00:00 INFO]: Hello World from maziPanel!', 'stdout');
    processManager._appendLog(testId, '[12:00:01 WARN]: Testing warning line', 'stderr');

    wsClient.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.event === 'pong' || msg.type === 'pong') {
        pongReceived = true;
        assert(msg.timestamp === pingSent, 'Pong timestamp must match sent timestamp');
        assert(typeof msg.serverTime === 'number', 'Pong serverTime must be a number');
      }

      if (msg.type === 'console_history' || msg.event === 'server_logs') {
        consoleHistoryReceived = true;
        assert(Array.isArray(msg.lines), 'console_history lines must be an Array');
        assert(msg.lines.length >= 2, 'Must contain the 2 logged lines');
        assert.strictEqual(typeof msg.lines[0], 'string', 'lines elements must be strings, not objects');
      }

      if (msg.type === 'console_line' || msg.event === 'console_output') {
        consoleLineReceived = true;
        assert.strictEqual(typeof msg.line, 'string', 'Live console_line "line" must be a string');
        assert(msg.line.includes('Live broadcast log line'), 'Must match emitted text');
      }
    });

    // Subscribe to test console
    wsClient.send(JSON.stringify({ type: 'subscribe_console', serverId: testId }));

    // Emit live line
    setTimeout(() => {
      processManager._appendLog(testId, '[12:00:02 INFO]: Live broadcast log line', 'stdout');
    }, 100);

    // Wait for events
    await new Promise((res) => setTimeout(res, 600));

    assert(pongReceived, 'Ping/Pong event must be received');
    assert(consoleHistoryReceived, 'console_history event must be received');
    assert(consoleLineReceived, 'Live console_line event must be received');
    console.log('    PASS: Real ping/pong, console history as string array, and live broadcast all verified');

    wsClient.close();
    tempHttp.close();

    // -----------------------------------------------------------------
    // TEST 5: SkinsRestorer Profile Resolution, P2P Ping & Ghost Player Prevention
    // -----------------------------------------------------------------
    console.log('[*] Test 5: SkinsRestorer Profile Resolution, P2P Ping & Ghost Player Prevention');
    const playerManager = require('../src/servers/playerManager');
    const srDir = path.join(testDir, 'plugins', 'SkinsRestorer');
    const srCacheDir = path.join(srDir, 'cache');
    const srSkinsDir = path.join(srDir, 'skins');
    const srPlayersDir = path.join(srDir, 'players');
    fs.mkdirSync(srCacheDir, { recursive: true });
    fs.mkdirSync(srSkinsDir, { recursive: true });
    fs.mkdirSync(srPlayersDir, { recursive: true });

    const sampleTextureHash = '7b611653ee727abf93bc6ec2072f07129153e0256daa2a5c45951914c9bc0145';
    const sampleMojangUuid = 'f72af069-da19-4ecf-92e5-83c8abcb166e';
    const sampleValueB64 = Buffer.from(JSON.stringify({
      timestamp: 1792087131035,
      profileId: 'f72af069da194ecf92e583c8abcb166e',
      profileName: 'seth',
      textures: {
        SKIN: {
          url: `http://textures.minecraft.net/texture/${sampleTextureHash}`
        }
      }
    }), 'utf8').toString('base64');

    fs.writeFileSync(path.join(srCacheDir, 'Seth.mojangcache'), JSON.stringify({
      uniqueId: sampleMojangUuid,
      timestamp: 1792087131,
      dataVersion: 1
    }), 'utf8');

    fs.writeFileSync(path.join(srSkinsDir, `${sampleMojangUuid}.playerskin`), JSON.stringify({
      uniqueId: sampleMojangUuid,
      lastKnownName: 'seth',
      value: sampleValueB64,
      signature: 'dummy',
      timestamp: 1792087131,
      dataVersion: 1
    }), 'utf8');

    // Simulate banned player pre-login rejection (UUID of player -> Disconnecting -> lost connection with parentheses)
    processManager._analyzeLine(testId, '[20:52:15] [User Authenticator #6/INFO]: UUID of player BannedGhost is 0dd458af-7f00-3b6d-bd67-af59b2a22a9d');
    processManager._analyzeLine(testId, '[20:52:16] [Server thread/INFO]: Disconnecting BannedGhost (/127.0.0.1:49258): You are banned from this server.');
    processManager._analyzeLine(testId, '[20:52:16] [Server thread/INFO]: BannedGhost (/127.0.0.1:49258) lost connection: You are banned from this server.');

    // Simulate actual login of Seth over local P2P tunnel port 37290
    processManager._analyzeLine(testId, '[20:58:50] [Server thread/INFO]: Seth[/127.0.0.1:37290] logged in with entity id 47041 at ([minecraft:overworld]-29.3, 110.0, 256.0)');

    const builtPlayers = playerManager._buildPlayersList(testId, [
      {
        peer_addr: '212.252.137.182:35779',
        username: 'musta',
        ping_ms: 28.4,
        active_streams: 1,
        local_ports: [37290]
      }
    ]);

    assert.strictEqual(builtPlayers.length, 1, 'Only logged-in player Seth must be online (BannedGhost must not be online)');
    assert.strictEqual(builtPlayers[0].username, 'Seth');
    assert.strictEqual(builtPlayers[0].ping, 28, 'Seth ping must match P2P tunnel stream ping (28 ms)');
    assert.strictEqual(builtPlayers[0].skinTextureHash, sampleTextureHash, 'Seth skinTextureHash must match SkinsRestorer texture hash');
    assert.strictEqual(builtPlayers[0].avatarUrl, `https://mc-heads.net/avatar/${sampleTextureHash}/64`, 'Seth avatarUrl must use SkinsRestorer texture hash');
    assert.strictEqual(builtPlayers[0].skinSource, 'skinsrestorer');
    console.log('    PASS: SkinsRestorer profile avatar, P2P tunnel port ping mapping, and ghost player prevention verified');

    console.log('========================================================');
    console.log('   ALL BACKEND CORE FEATURES VERIFIED AND PASSED 100%   ');
    console.log('========================================================');
  } finally {
    // Cleanup
    serverRegistry.delete(testId);
    if (fs.existsSync(testDir)) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('[TEST FAILURE]:', err);
  process.exit(1);
});
