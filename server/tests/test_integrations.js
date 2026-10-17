const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const AdmZip = require('adm-zip');

const webhookService = require('../src/integrations/webhookService');
const discordBotService = require('../src/integrations/discordBotService');
const { integrationStorage } = require('../src/integrations/integrationStorage');
const ssrfValidator = require('../src/integrations/ssrfValidator');
const processManager = require('../src/servers/processManager');
const fileManager = require('../src/servers/fileManager');
const archiveBrowser = require('../src/backups/archiveBrowser');
const serverRegistry = require('../src/servers/serverRegistry');
const config = require('../config');

// Helper for test counting
let passedCount = 0;
let failedCount = 0;

function pass(name) {
  passedCount++;
  console.log(`  [PASS] ${name}`);
}

function fail(name, err) {
  failedCount++;
  console.error(`  [FAIL] ${name}:`, err.message || err);
}

async function run() {
  console.log('====================================================');
  console.log('  maziPanel Integrations & Lifecycle Test Suite');
  console.log('====================================================\n');

  const integrationsDir = integrationStorage.getIntegrationsDir();

  try {
    // =========================================================================
    // 1. Webhooks CRUD Operations (Default Admin / Single User)
    // =========================================================================
    console.log('[*] Step 1: Testing Webhook Service CRUD operations...');

    const initialList = webhookService.getAll('testuser');
    assert(Array.isArray(initialList), 'getAll() should return an array');
    pass('getAll() returns array');

    // Create Discord Webhook
    const whDiscord = await webhookService.create({
      name: 'Discord Production Alerts',
      url: 'https://discord.com/api/webhooks/mock/111222333',
      format: 'discord',
      events: ['server_start', 'server_done', 'server_stop'],
      enabled: true
    }, 'testuser');

    assert(whDiscord && whDiscord.id, 'Webhook creation should return object with id');
    assert.strictEqual(whDiscord.name, 'Discord Production Alerts');
    assert.strictEqual(whDiscord.format, 'discord');
    assert.strictEqual(whDiscord.enabled, true);
    assert.deepStrictEqual(whDiscord.events, ['server_start', 'server_done', 'server_stop']);
    pass('Create Discord webhook');

    // Create Generic JSON Webhook
    const whGeneric = await webhookService.create({
      name: 'Custom Webhook API',
      url: 'https://example.com/api/servers/notify',
      format: 'generic',
      events: ['server_crash', 'server_restart'],
      headers: {
        'Authorization': 'Bearer secret-test-token',
        'X-Panel-Origin': 'maziPanel'
      },
      enabled: false
    }, 'testuser');

    assert(whGeneric && whGeneric.id, 'Generic webhook creation should return object with id');
    assert.strictEqual(whGeneric.format, 'generic');
    assert.strictEqual(whGeneric.enabled, false);
    assert.strictEqual(whGeneric.headers['X-Panel-Origin'], 'maziPanel');
    pass('Create Generic webhook with custom headers');

    // getById
    const found = webhookService.getById(whDiscord.id, 'testuser');
    assert(found && found.id === whDiscord.id, 'getById should return created webhook');
    pass('getById() finds existing webhook');

    const notFound = webhookService.getById('non-existent-id-xyz', 'testuser');
    assert.strictEqual(notFound, null, 'getById for non-existent ID should return null');
    pass('getById() returns null for unknown ID');

    // update
    const updated = await webhookService.update(whDiscord.id, {
      name: 'Updated Discord Alerts',
      events: ['server_done', 'server_crash'],
      enabled: false
    }, 'testuser');
    assert.strictEqual(updated.name, 'Updated Discord Alerts');
    assert.strictEqual(updated.enabled, false);
    assert.deepStrictEqual(updated.events, ['server_done', 'server_crash']);
    pass('update() modifies fields correctly');

    // delete
    const deleted = webhookService.delete(whGeneric.id, 'testuser');
    assert.strictEqual(deleted.id, whGeneric.id, 'delete() returns deleted webhook');
    assert.strictEqual(webhookService.getById(whGeneric.id, 'testuser'), null, 'deleted webhook should no longer exist');
    pass('delete() removes webhook');

    // Clean up created discord webhook
    webhookService.delete(whDiscord.id, 'testuser');

    // =========================================================================
    // 2. SSRF Protection & URL Validation
    // =========================================================================
    console.log('\n[*] Step 2: Testing SSRF Protection and Validation...');

    // Empty name validation
    await assert.rejects(async () => {
      await webhookService.create({ name: '', url: 'https://example.com/valid' }, 'testuser');
    }, /zorunludur/i, 'Creating webhook with empty name should fail');
    pass('Validation rejects empty name');

    // Invalid protocol validation
    await assert.rejects(async () => {
      await webhookService.create({ name: 'Invalid Proto', url: 'ftp://example.com/wh' }, 'testuser');
    }, /http:\/\/ veya https:\/\//i, 'Creating webhook with non-http protocol should fail');
    pass('Validation rejects non-http protocols');

    // SSRF: 127.0.0.1
    await assert.rejects(async () => {
      await webhookService.create({ name: 'SSRF Loopback', url: 'http://127.0.0.1:8080/wh' }, 'testuser');
    }, /yerel ağ veya sunucu içi bir adrese yönlendirilemez/i, 'Loopback 127.0.0.1 must be rejected by SSRF guard');
    pass('SSRF rejects 127.0.0.1 (Loopback)');

    // SSRF: localhost
    await assert.rejects(async () => {
      await webhookService.create({ name: 'SSRF Localhost', url: 'http://localhost:3000/api' }, 'testuser');
    }, /yerel ağ veya sunucu içi bir adrese yönlendirilemez/i, 'localhost hostname must be rejected by SSRF guard');
    pass('SSRF rejects localhost');

    // SSRF: 192.168.1.1 (Private RFC 1918)
    await assert.rejects(async () => {
      await webhookService.create({ name: 'SSRF Private', url: 'http://192.168.1.1/admin' }, 'testuser');
    }, /yerel ağ veya sunucu içi bir adrese yönlendirilemez/i, 'Private 192.168.1.1 must be rejected by SSRF guard');
    pass('SSRF rejects 192.168.1.1 (Private Class C)');

    // SSRF: 169.254.169.254 (Cloud metadata / Link-local)
    await assert.rejects(async () => {
      await webhookService.create({ name: 'SSRF Metadata', url: 'http://169.254.169.254/latest/meta-data' }, 'testuser');
    }, /yerel ağ veya sunucu içi bir adrese yönlendirilemez/i, 'Link-local 169.254.169.254 must be rejected by SSRF guard');
    pass('SSRF rejects 169.254.169.254 (Cloud metadata)');

    // SSRF validator direct checks
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('10.0.0.1'), true);
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('172.16.5.1'), true);
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('100.64.0.1'), true);
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('::1'), true);
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('fc00::1'), true);
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('fe80::1'), true);
    assert.strictEqual(ssrfValidator.isPrivateOrBlockedIp('::ffff:127.0.0.1'), true);
    pass('SSRF validator correctly classifies IPv4/IPv6 private ranges');

    // =========================================================================
    // 3. Multi-User Integration Isolation
    // =========================================================================
    console.log('\n[*] Step 3: Testing Multi-User Integration Isolation...');

    const userA = 'mert';
    const userB = 'alper';

    // User A creates webhook
    const whUserA = await webhookService.create({
      name: 'Mert Discord Channel',
      url: 'https://discord.com/api/webhooks/mert/123',
      format: 'discord',
      events: ['server_start', 'server_done']
    }, userA);

    // User B creates webhook
    const whUserB = await webhookService.create({
      name: 'Alper Webhook API',
      url: 'https://discord.com/api/webhooks/alper/456',
      format: 'discord',
      events: ['server_stop']
    }, userB);

    // Verify User A only sees their own webhooks
    const listA = webhookService.getAll(userA);
    assert.strictEqual(listA.length, 1, 'User A should have exactly 1 webhook');
    assert.strictEqual(listA[0].id, whUserA.id);
    assert.strictEqual(listA[0].name, 'Mert Discord Channel');

    // Verify User B only sees their own webhooks
    const listB = webhookService.getAll(userB);
    assert.strictEqual(listB.length, 1, 'User B should have exactly 1 webhook');
    assert.strictEqual(listB[0].id, whUserB.id);
    assert.strictEqual(listB[0].name, 'Alper Webhook API');
    pass('Webhooks list is strictly isolated between users');

    // User B cannot get User A's webhook
    const crossGet = webhookService.getById(whUserA.id, userB);
    assert.strictEqual(crossGet, null, 'User B must not be able to get User A webhook');
    pass('Cross-user getById() returns null');

    // User B cannot delete User A's webhook
    assert.throws(() => {
      webhookService.delete(whUserA.id, userB);
    }, /bulunamadı/i, 'User B deleting User A webhook must throw not found');
    pass('Cross-user delete() is rejected');

    // Clean up test webhooks
    webhookService.delete(whUserA.id, userA);
    webhookService.delete(whUserB.id, userB);

    // =========================================================================
    // 4. Token Privacy, Write-Only Behavior & Discord Bot Isolation
    // =========================================================================
    console.log('\n[*] Step 4: Testing Token Privacy and Write-Only Behavior...');

    // User A configures bot with token
    await discordBotService.updateConfig(userA, {
      enabled: true,
      token: 'secret-token-mert-xyz-9876',
      guildId: '111222333',
      voiceChannelId: '444555666'
    });

    // User B configures bot with different token
    await discordBotService.updateConfig(userB, {
      enabled: false,
      token: 'secret-token-alper-abc-1234',
      guildId: '777888999'
    });

    // Verify User A's public config: token MUST NOT be exposed
    const pubConfigA = discordBotService.getPublicConfig(userA);
    assert.strictEqual(pubConfigA.hasToken, true, 'hasToken should be true');
    assert.strictEqual(pubConfigA.tokenMasked, '••••••••9876', 'tokenMasked should show last 4 chars');
    assert.strictEqual(pubConfigA.token, undefined, 'token field must not be in public config');
    assert.strictEqual(JSON.stringify(pubConfigA).includes('secret-token-mert'), false, 'Raw token must not appear in serialized public config');
    pass('API config never exposes raw bot token');

    // Verify User B's public config
    const pubConfigB = discordBotService.getPublicConfig(userB);
    assert.strictEqual(pubConfigB.hasToken, true);
    assert.strictEqual(pubConfigB.tokenMasked, '••••••••1234');
    assert.strictEqual(pubConfigB.guildId, '777888999');
    pass('Discord bot config is isolated between users');

    // Write-only token test: update User A without providing token -> token must be preserved
    await discordBotService.updateConfig(userA, {
      guildId: '999999999',
      token: '' // Empty string must not overwrite existing token
    });

    const cfgAfterEmpty = discordBotService.getConfig(userA);
    assert.strictEqual(cfgAfterEmpty.token, 'secret-token-mert-xyz-9876', 'Existing token must be preserved on empty PUT');
    assert.strictEqual(cfgAfterEmpty.guildId, '999999999', 'Other fields must still update');
    pass('Write-only token policy preserves token when empty in PUT');

    // Verify getStatus does not expose token
    const statusA = discordBotService.getStatus(userA);
    assert.strictEqual(statusA.configured, true);
    assert.strictEqual(statusA.hasToken, true);
    assert.strictEqual(statusA.token, undefined, 'getStatus must never include token property');
    assert.strictEqual(JSON.stringify(statusA).includes('secret-token-mert'), false, 'Raw token must not appear in status');
    pass('getStatus() does not leak bot token');

    // =========================================================================
    // 5. Server Ownership Event Triggering & Mock HTTP Delivery
    // =========================================================================
    console.log('\n[*] Step 5: Testing Server Ownership Webhook Filtering & Mock Delivery...');

    // Temporarily allow test loopback ONLY for mock server delivery verification
    process.env.ALLOW_TEST_LOOPBACK = 'true';

    const receivedRequests = [];
    const mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
        receivedRequests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: parsed
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    const baseMockUrl = `http://127.0.0.1:${port}`;

    // Register a mock server owned by 'mert'
    serverRegistry.register({
      id: 'srv-mert-1',
      name: 'Mert Survival Server',
      owner: 'mert',
      directory: config.TEMP_DIR,
      jarFile: 'server.jar'
    });

    // Create webhook for mert and webhook for alper
    const whMertMock = await webhookService.create({
      name: 'Mert Mock Webhook',
      url: `${baseMockUrl}/mert-hook`,
      format: 'discord',
      events: ['server_start', 'server_done'],
      enabled: true
    }, 'mert');

    const whAlperMock = await webhookService.create({
      name: 'Alper Mock Webhook',
      url: `${baseMockUrl}/alper-hook`,
      format: 'discord',
      events: ['server_start', 'server_done'],
      enabled: true
    }, 'alper');

    // Trigger server_start on srv-mert-1: ONLY mert's webhook should receive it!
    receivedRequests.length = 0;
    const triggerRes = await webhookService.trigger('server_start', {
      serverId: 'srv-mert-1'
    });

    assert.strictEqual(triggerRes.length, 1, 'Only owner (mert) webhook should trigger');
    assert.strictEqual(receivedRequests.length, 1, 'Mock server received 1 request');
    assert.strictEqual(receivedRequests[0].url, '/mert-hook', 'Delivered only to mert webhook URL');
    assert(Array.isArray(receivedRequests[0].body.embeds), 'Discord payload contains embeds');
    pass('Webhook triggers only for the owner of the server');

    // Clean up mock webhooks, server, and server
    webhookService.delete(whMertMock.id, 'mert');
    webhookService.delete(whAlperMock.id, 'alper');
    serverRegistry.delete('srv-mert-1');
    await new Promise((resolve) => mockServer.close(resolve));
    delete process.env.ALLOW_TEST_LOOPBACK;
    pass('Mock server delivery test closed cleanly');

    // =========================================================================
    // 6. ProcessManager Lifecycle Hooks and Redundant Log Cleanliness
    // =========================================================================
    console.log('\n[*] Step 6: Testing ProcessManager lifecycle hooks and log cleanliness...');

    assert.doesNotThrow(() => {
      processManager._triggerWebhook('server_start', 'srv-unknown-123');
      processManager._triggerWebhook('server_done', 'srv-unknown-123');
      processManager._triggerWebhook('server_stop', 'srv-unknown-123');
      processManager._triggerWebhook('server_restart', 'srv-unknown-123');
      processManager._triggerWebhook('server_crash', 'srv-unknown-123');
    }, 'ProcessManager._triggerWebhook should never throw');
    pass('ProcessManager._triggerWebhook is completely safe');

    assert.doesNotThrow(() => {
      processManager._triggerDiscordVoice('join');
      processManager._triggerDiscordVoice('leave');
    }, 'ProcessManager._triggerDiscordVoice should never throw');
    pass('ProcessManager._triggerDiscordVoice is completely safe');

    // Verify redundant log line removal in _analyzeLine
    const testSrvId = 'test-log-check-srv';
    const inst = processManager._getOrCreateInstance(testSrvId);
    inst.status = 'starting';
    inst.ringBuffer = [];

    const nativeDoneLine = '[11:22:33 INFO]: Done (1.450s)! For help, type "help"';
    processManager._analyzeLine(testSrvId, nativeDoneLine);

    assert.strictEqual(inst.status, 'online', 'Server status should transition to online');
    const hasRedundantLog = inst.ringBuffer.some((entry) =>
      entry.text && entry.text.includes('Sunucu çalışıyor') && entry.text.includes('açıldı')
    );
    assert.strictEqual(hasRedundantLog, false, 'Redundant "Sunucu çalışıyor (X sn\'de açıldı)" log MUST NOT be emitted');
    pass('Redundant "Sunucu çalışıyor (X sn\'de açıldı)" log successfully removed');

    processManager.instances.delete(testSrvId);

    // =========================================================================
    // 7. FileManager and ArchiveBrowser isHidden Support
    // =========================================================================
    console.log('\n[*] Step 7: Testing isHidden support in FileManager and ArchiveBrowser...');

    const testDir = path.join(config.TEMP_DIR, 'test_hidden_verification');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, '.env'), 'PORT=8080');
    fs.writeFileSync(path.join(testDir, 'server.properties'), 'gamemode=survival');
    fs.mkdirSync(path.join(testDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'world'), { recursive: true });

    serverRegistry.register({
      id: 'hidden-test-srv',
      name: 'Hidden Test Server',
      directory: testDir,
      jarFile: 'server.jar'
    });

    const fileList = fileManager.listFiles('hidden-test-srv', '');
    const dotEnv = fileList.find((f) => f.name === '.env');
    const dotGit = fileList.find((f) => f.name === '.git');
    const serverProps = fileList.find((f) => f.name === 'server.properties');
    const worldDir = fileList.find((f) => f.name === 'world');

    assert(dotEnv && dotEnv.isHidden === true, '.env should have isHidden: true');
    assert(dotGit && dotGit.isHidden === true, '.git should have isHidden: true');
    assert(serverProps && serverProps.isHidden === false, 'server.properties should have isHidden: false');
    assert(worldDir && worldDir.isHidden === false, 'world directory should have isHidden: false');
    pass('FileManager.listFiles() correctly flags isHidden for files and directories');

    serverRegistry.delete('hidden-test-srv');
    fs.rmSync(testDir, { recursive: true, force: true });

    const zip = new AdmZip();
    zip.addFile('.paper-world.yml', Buffer.from('setting: true'));
    zip.addFile('ops.json', Buffer.from('[]'));
    zip.addFile('.config/internal.cfg', Buffer.from('mode=debug'));

    const testZipPath = path.join(config.TEMP_DIR, 'test_hidden_archive.zip');
    zip.writeZip(testZipPath);

    const archiveRoot = archiveBrowser.listDirectoryChildren(testZipPath, '');
    const archDotYml = archiveRoot.entries.find((e) => e.name === '.paper-world.yml');
    const archDotConfig = archiveRoot.entries.find((e) => e.name === '.config');
    const archOps = archiveRoot.entries.find((e) => e.name === 'ops.json');

    assert(archDotYml && archDotYml.isHidden === true, 'Archive .paper-world.yml should have isHidden: true');
    assert(archDotConfig && archDotConfig.isHidden === true, 'Archive .config folder should have isHidden: true');
    assert(archOps && archOps.isHidden === false, 'Archive ops.json should have isHidden: false');
    pass('ArchiveBrowser.listDirectoryChildren() correctly flags isHidden for entries');

    fs.rmSync(testZipPath, { force: true });

  } catch (err) {
    fail('Global test suite error', err);
  }

  console.log('\n====================================================');
  console.log(`  Tests Completed: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('====================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
