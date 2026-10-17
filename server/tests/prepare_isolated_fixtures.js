/**
 * prepare_isolated_fixtures.js
 *
 * Sets up isolated QA fixtures for test suite execution without touching
 * production servers, production data, live energy stats, live logs, or live admin accounts.
 *
 * Usage:
 *   node tests/prepare_isolated_fixtures.js [QA_ROOT]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Checks whether childPath is a strict descendant of parentPath (respecting directory boundary).
 */
function isStrictDescendant(childPath, parentPath) {
  const normChild = path.resolve(childPath);
  const normParent = path.resolve(parentPath);
  const rel = path.relative(normParent, normChild);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Rigorously validates QA root path.
 * Rejects heuristics, verifies canonical realpath of existing ancestors,
 * and ensures it is a strict descendant of allowed temporary bases.
 */
function validateQaRoot(targetPath) {
  if (!targetPath) {
    throw new Error('QA_ROOT path must be provided.');
  }
  const resolved = path.resolve(targetPath);

  // 1. Critical rejection: root filesystem
  if (resolved === '/' || resolved === path.parse(resolved).root) {
    throw new Error(`CRITICAL SECURITY ERROR: QA root cannot be root directory: ${resolved}`);
  }

  // 2. Critical rejection: direct production directories
  const forbiddenProductionPaths = [
    '/mazideveloper',
    '/mazideveloper/data',
    '/mazideveloper/servers',
    '/mazideveloper/backups',
    '/mazideveloper/client'
  ];

  for (const forbidden of forbiddenProductionPaths) {
    const normForbidden = path.resolve(forbidden);
    if (resolved === normForbidden) {
      throw new Error(`CRITICAL SECURITY ERROR: QA root cannot target production directory: ${resolved}`);
    }
    if (forbidden !== '/mazideveloper' && isStrictDescendant(resolved, normForbidden)) {
      throw new Error(`CRITICAL SECURITY ERROR: QA root cannot reside within production directory: ${forbidden}`);
    }
  }

  // 3. Allowed canonical parent bases with strict directory boundary
  const allowedBases = [
    '/mazideveloper/temp',
    '/tmp',
    '/var/tmp',
    os.tmpdir()
  ].map(b => path.resolve(b));

  let isAllowed = false;
  for (const base of allowedBases) {
    if (isStrictDescendant(resolved, base)) {
      isAllowed = true;
      break;
    }
  }

  if (!isAllowed) {
    throw new Error(
      `CRITICAL SECURITY ERROR: QA root must be a strict directory-boundary descendant of /mazideveloper/temp, /tmp, /var/tmp, or os.tmpdir(). Received: ${resolved}`
    );
  }

  // 4. Validate existing directory or ancestors for symlink traversal to production
  let checkCursor = resolved;
  while (checkCursor && checkCursor !== path.parse(checkCursor).root) {
    if (fs.existsSync(checkCursor)) {
      try {
        const canonical = fs.realpathSync(checkCursor);
        for (const forbidden of forbiddenProductionPaths) {
          const normForbidden = path.resolve(forbidden);
          if (canonical === normForbidden || (forbidden !== '/mazideveloper' && isStrictDescendant(canonical, normForbidden))) {
            throw new Error(`CRITICAL SECURITY ERROR: QA root ancestor symlink resolves to production path: ${canonical}`);
          }
        }
      } catch (err) {
        if (err.message.includes('CRITICAL SECURITY ERROR')) throw err;
      }
      break;
    }
    const parent = path.dirname(checkCursor);
    if (parent === checkCursor) break;
    checkCursor = parent;
  }

  return resolved;
}

function createTarGzArchive(targetFile, sourceFiles) {
  // Try system tar first if available
  try {
    const parentDir = path.dirname(targetFile);
    const tempDir = path.join(parentDir, `.tar_staging_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    for (const file of sourceFiles) {
      const fullDest = path.join(tempDir, file.name);
      fs.mkdirSync(path.dirname(fullDest), { recursive: true });
      fs.writeFileSync(fullDest, file.content);
    }

    const fileNames = sourceFiles.map(f => f.name);
    const res = spawnSync('tar', ['-czf', targetFile, '-C', tempDir, ...fileNames], { stdio: 'pipe' });
    fs.rmSync(tempDir, { recursive: true, force: true });

    if (res.status === 0 && fs.existsSync(targetFile)) {
      return;
    }
  } catch {
    // Fall back to pure JS ustar generator
  }

  // Pure JS ustar tar generator fallback (no external dependencies required)
  const blocks = [];
  for (const f of sourceFiles) {
    const header = Buffer.alloc(512);
    header.write(f.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const size = f.content.length;
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
    const nowSec = Math.floor(Date.now() / 1000);
    header.write(nowSec.toString(8).padStart(11, '0') + ' ', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);
    blocks.push(f.content);
    const pad = 512 - (f.content.length % 512);
    if (pad < 512) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  const compressed = zlib.gzipSync(Buffer.concat(blocks));
  fs.writeFileSync(targetFile, compressed);
}

function prepareFixtures(rawQaRoot) {
  const qaRoot = validateQaRoot(rawQaRoot);
  console.log(`[QA Fixtures] Preparing isolated test environment at: ${qaRoot}`);

  const dataDir = path.join(qaRoot, 'data');
  const serversDir = path.join(qaRoot, 'servers');
  const backupsDir = path.join(qaRoot, 'backups');
  const tempDir = path.join(qaRoot, 'temp');

  // Verify internal subdirectories strictly remain inside QA root
  [dataDir, serversDir, backupsDir, tempDir].forEach((dir) => {
    if (!isStrictDescendant(dir, qaRoot)) {
      throw new Error(`CRITICAL: Subdirectory ${dir} escaped QA root ${qaRoot}`);
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // 1. Seed server fixture: test-mv2n0bep
  const serverId = 'test-mv2n0bep';
  const serverDir = path.join(serversDir, serverId);
  const serverLogsDir = path.join(serverDir, 'logs');
  const serverConfigDir = path.join(serverDir, 'config.d');
  const serverPluginsDir = path.join(serverDir, 'plugins', 'Test');

  fs.mkdirSync(serverLogsDir, { recursive: true });
  fs.mkdirSync(serverConfigDir, { recursive: true });
  fs.mkdirSync(serverPluginsDir, { recursive: true });

  const serverPropertiesContent = [
    '# Minecraft server properties - QA Fixture',
    'server-port=25565',
    'motd=QA Isolated Test Server',
    'max-players=20',
    'difficulty=normal',
    'gamemode=survival',
    'pvp=true',
    'white-list=false',
    'online-mode=false',
    'enable-rcon=false',
    'enable-command-block=true',
    'view-distance=10',
    'simulation-distance=10'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(serverDir, 'server.properties'), serverPropertiesContent, 'utf8');

  // Create harmless fake jar with valid manifest zip
  const fakeJar = new AdmZip();
  fakeJar.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\nCreated-By: maziPanel QA Isolation\n', 'utf8'));
  fakeJar.writeZip(path.join(serverDir, 'server.jar'));

  // Tiny latest.log
  const logContent = [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    '[12:00:01] [Server thread/INFO]: Loading properties',
    '[12:00:02] [Server thread/INFO]: Default game type: SURVIVAL',
    '[12:00:03] [Server thread/INFO]: Done (1.234s)! For help, type "help"'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(serverLogsDir, 'latest.log'), logContent, 'utf8');

  // Additional fixtures for browser and routing navigation
  fs.writeFileSync(path.join(serverConfigDir, 'child.txt'), 'sample child configuration text\n', 'utf8');
  fs.writeFileSync(path.join(serverPluginsDir, 'config.yml'), 'test_plugin:\n  enabled: true\n  version: 1.0.0\n', 'utf8');
  fs.writeFileSync(path.join(serverDir, 'LICENSE'), 'MIT License - maziPanel QA Isolation Fixture\n', 'utf8');
  fs.writeFileSync(path.join(serverDir, 'banned-players.json'), '[]\n', 'utf8');
  fs.writeFileSync(path.join(serverDir, 'banned-ips.json'), '[]\n', 'utf8');

  // Seed data/servers.json
  const serverRecord = {
    id: serverId,
    name: serverId,
    owner: 'masteradmin',
    directory: serverDir,
    jarFile: 'server.jar',
    javaPath: '',
    minRam: '2G',
    maxRam: '4G',
    jvmFlags: '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
    serverArgs: 'nogui',
    port: 25565,
    autoRestart: true,
    maxCrashRetries: 5,
    autoStartOnBoot: 'never',
    lastRunning: false,
    settings: {
      memory: { minMB: 2048, maxMB: 4096 },
      startup: {
        jarFile: 'server.jar',
        javaPath: null,
        jvmFlags: '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
        serverArgs: 'nogui'
      },
      autoStartOnBoot: 'never',
      crash: { autoRestart: true, maxRetries: 5, delaySec: 3 },
      stop: { command: 'stop', timeoutSec: 30, onTimeout: 'kill' },
      restart: { mode: 'graceful', delaySec: 1, warnMessage: null, warnSeconds: 5 }
    },
    icon: null,
    iconUrl: null,
    iconVersion: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z'
  };
  fs.writeFileSync(path.join(dataDir, 'servers.json'), JSON.stringify([serverRecord], null, 2), 'utf8');

  // 2. Seed Backups (.zip and .tar.gz)
  const serverBackupDir = path.join(backupsDir, serverId);
  fs.mkdirSync(serverBackupDir, { recursive: true });

  const zipBackupPath = path.join(serverBackupDir, 'test-mv2n0bep-seed-backup.zip');
  const zip = new AdmZip();
  zip.addFile('server.properties', Buffer.from(serverPropertiesContent, 'utf8'));
  zip.addFile('logs/latest.log', Buffer.from(logContent, 'utf8'));
  zip.addFile('config.d/child.txt', Buffer.from('sample child configuration text\n', 'utf8'));
  zip.addFile('LICENSE', Buffer.from('MIT License - maziPanel QA Isolation Fixture\n', 'utf8'));
  zip.writeZip(zipBackupPath);

  const tarGzBackupPath = path.join(serverBackupDir, 'test-mv2n0bep-seed-backup.tar.gz');
  createTarGzArchive(tarGzBackupPath, [
    { name: 'server.properties', content: Buffer.from(serverPropertiesContent, 'utf8') },
    { name: 'logs/latest.log', content: Buffer.from(logContent, 'utf8') },
    { name: 'config.d/child.txt', content: Buffer.from('sample child configuration text\n', 'utf8') },
    { name: 'LICENSE', content: Buffer.from('MIT License - maziPanel QA Isolation Fixture\n', 'utf8') }
  ]);

  const zipStat = fs.statSync(zipBackupPath);
  const tarStat = fs.statSync(tarGzBackupPath);

  const backupsList = [
    {
      id: 'backup-seed-zip-01',
      serverId: serverId,
      serverName: serverId,
      name: 'test-mv2n0bep Seed Zip Backup',
      filename: 'test-mv2n0bep-seed-backup.zip',
      filePath: zipBackupPath,
      destDir: serverBackupDir,
      format: 'zip',
      level: 6,
      compression: 'zip',
      exclusions: [],
      sizeBytes: zipStat.size,
      sizeFormatted: formatBytes(zipStat.size),
      createdAt: '2026-10-11T10:00:00.000Z',
      updatedAt: '2026-10-11T10:00:00.000Z',
      source: 'manual',
      singleFile: false,
      exists: true
    },
    {
      id: 'backup-seed-targz-02',
      serverId: serverId,
      serverName: serverId,
      name: 'test-mv2n0bep Seed TarGz Backup',
      filename: 'test-mv2n0bep-seed-backup.tar.gz',
      filePath: tarGzBackupPath,
      destDir: serverBackupDir,
      format: 'tar.gz',
      level: 6,
      compression: 'gzip',
      exclusions: [],
      sizeBytes: tarStat.size,
      sizeFormatted: formatBytes(tarStat.size),
      createdAt: '2026-10-11T10:00:00.000Z',
      updatedAt: '2026-10-11T10:00:00.000Z',
      source: 'manual',
      singleFile: false,
      exists: true
    }
  ];
  fs.writeFileSync(path.join(dataDir, 'backups.json'), JSON.stringify(backupsList, null, 2), 'utf8');

  // 3. Seed backup schedule for test-mv2n0bep
  const schedulesMap = {
    [serverId]: {
      serverId,
      enabled: false,
      frequency: 'daily',
      intervalHours: 6,
      intervalWindow: { from: '02:00', to: '06:00' },
      time: '04:00',
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      format: 'zip',
      level: 6,
      retentionCount: 5,
      exclusions: ['logs', 'crash-reports', 'cache']
    }
  };
  fs.writeFileSync(path.join(dataDir, 'backup-schedules.json'), JSON.stringify(schedulesMap, null, 2), 'utf8');

  console.log(`[QA Fixtures] Successfully seeded server '${serverId}', navigation files, zip backup, and tar.gz backup.`);
}

if (require.main === module) {
  const targetQaRoot = process.argv[2] || process.env.QA_ROOT || '/mazideveloper/temp/qa-20261011';
  try {
    prepareFixtures(targetQaRoot);
    process.exit(0);
  } catch (err) {
    console.error(`[QA Fixtures ERROR] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { prepareFixtures, validateQaRoot, isStrictDescendant };
