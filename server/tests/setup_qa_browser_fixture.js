/**
 * Practical Browser Fixture Utility for QA and Coordinator Validation
 *
 * Strict safety rules:
 * - Validates realpath QA root and all its ancestors BEFORE importing any config-dependent modules.
 * - Establishes and validates scoped DATA_DIR, SERVERS_DIR, BACKUPS_DIR, TEMP_DIR, CLIENT_DIST_DIR strictly below QA root.
 * - Rejects any pre-existing mismatched environment variables.
 * - Only after strict validation, requires config-dependent modules.
 * - Uses separate fixture dir QA_ROOT/servers/qa-real-java-20261011 (NOT QA_ROOT/server).
 * - Compiles a real Java console jar using official installed JDK (javac/jar).
 * - Registers server with version 1.20.4, type purpur, javaPath detected, memory 128-256MB, and graceful stop.
 * - Seeds 1500-line editor file, sample zip, and energy stats in QA DATA_DIR with correct schema.
 * - NEVER touches production paths, SSH, credentials, or user runtime files.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

// ==============================================================================
// STEP 1: STRICT CANONICAL QA ROOT AND ANCESTORS VALIDATION (BEFORE ANY REQUIRES)
// ==============================================================================

const isLinux = process.platform !== 'win32';
const canonicalLinuxRoot = '/mazideveloper/temp/qa-20261011';
let rawQARoot = isLinux
  ? (process.env.MAZI_QA_ROOT || canonicalLinuxRoot)
  : (process.env.MAZI_QA_ROOT || path.resolve(__dirname, '../temp/qa-20261011'));

// Strict check: On Linux, must be exactly /mazideveloper/temp/qa-20261011
if (isLinux && path.resolve(rawQARoot) !== path.resolve(canonicalLinuxRoot)) {
  throw new Error(`[SAFETY REJECTION] Strict Linux QA root must be exactly '${canonicalLinuxRoot}', received: '${rawQARoot}'`);
}

rawQARoot = path.resolve(rawQARoot);

// Ensure QA root directory exists
fs.mkdirSync(rawQARoot, { recursive: true });

// Resolve realpath
const realQARoot = fs.realpathSync(rawQARoot);

// Forbidden production paths and roots
const forbiddenProductionPaths = [
  '/mazideveloper/servers',
  '/mazideveloper/data',
  '/mazideveloper/client',
  '/mazideveloper/server',
  '/home',
  '/var',
  '/etc',
  '/root'
];

// Check realQARoot and every ancestor
let currentCheck = realQARoot;
while (currentCheck && currentCheck !== path.dirname(currentCheck)) {
  for (const forbidden of forbiddenProductionPaths) {
    if (currentCheck.toLowerCase() === path.resolve(forbidden).toLowerCase()) {
      throw new Error(`[SAFETY REJECTION] QA root or ancestor resolves to production directory: ${currentCheck}`);
    }
  }
  currentCheck = path.dirname(currentCheck);
}

// ==============================================================================
// STEP 2: REJECT MISMATCHED EXISTING ENV VARIABLES
// ==============================================================================

const scopedEnvKeys = ['DATA_DIR', 'SERVERS_DIR', 'BACKUPS_DIR', 'TEMP_DIR', 'CLIENT_DIST_DIR'];
for (const key of scopedEnvKeys) {
  if (process.env[key]) {
    const existingPath = path.resolve(process.env[key]);
    if (!existingPath.startsWith(realQARoot + path.sep) && existingPath !== realQARoot) {
      throw new Error(`[SAFETY REJECTION] Pre-existing env variable ${key}=${process.env[key]} points outside QA root ${realQARoot}`);
    }
  }
}

// ==============================================================================
// STEP 3: ESTABLISH AND VALIDATE SCOPED DIRECTORIES STRICTLY BELOW QA ROOT
// ==============================================================================

const qaDataDir = path.join(realQARoot, 'data');
const qaServersDir = path.join(realQARoot, 'servers');
const qaBackupsDir = path.join(realQARoot, 'backups');
const qaTempDir = path.join(realQARoot, 'temp');
const qaDistDir = path.join(realQARoot, 'dist');

fs.mkdirSync(qaDataDir, { recursive: true });
fs.mkdirSync(qaServersDir, { recursive: true });
fs.mkdirSync(qaBackupsDir, { recursive: true });
fs.mkdirSync(qaTempDir, { recursive: true });
fs.mkdirSync(qaDistDir, { recursive: true });

process.env.DATA_DIR = qaDataDir;
process.env.SERVERS_DIR = qaServersDir;
process.env.BACKUPS_DIR = qaBackupsDir;
process.env.TEMP_DIR = qaTempDir;
process.env.CLIENT_DIST_DIR = qaDistDir;

// ==============================================================================
// STEP 4: NOW REQUIRE CONFIG-DEPENDENT MODULES
// ==============================================================================

const defaultIconHelper = require('../src/servers/defaultIconHelper');
const serverRegistry = require('../src/servers/serverRegistry');

function detectJavaPath() {
  if (process.env.JAVA_HOME) {
    const binJava = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(binJava)) return binJava;
  }
  const knownLinuxPaths = [
    '/usr/lib/jvm/jdk-27-oracle-x64/bin/java',
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
    '/usr/lib/jvm/java-17-openjdk-amd64/bin/java'
  ];
  for (const kp of knownLinuxPaths) {
    if (fs.existsSync(kp)) return kp;
  }
  try {
    const whichCmd = process.platform === 'win32' ? 'where.exe java' : 'which java';
    const out = execSync(whichCmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return 'java';
}

function buildJavaConsoleJar(serverDir) {
  const javaSource = `import java.io.BufferedReader;
import java.io.InputStreamReader;

public class ConsoleRunner {
    public static void main(String[] args) throws Exception {
        System.out.println("[Server thread/INFO]: Starting minecraft server version 1.20.4-QA");
        System.out.println("[Server thread/INFO]: Loading properties");
        System.out.println("[Server thread/INFO]: Default game type: SURVIVAL");
        System.out.println("[Server thread/INFO]: Preparing level \\"world\\"");

        // 3-second startup delay
        Thread.sleep(3000);

        // Minecraft standard ready marker line
        System.out.println("[Server thread/INFO]: Done (3.012s)! For help, type \\"help\\"");

        // Continuous 1s background tick stream
        Thread ticker = new Thread(() -> {
            int tick = 0;
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(1000);
                    tick++;
                    long free = Runtime.getRuntime().freeMemory() / 1024 / 1024;
                    long total = Runtime.getRuntime().totalMemory() / 1024 / 1024;
                    System.out.println("[Server thread/INFO]: [Tick #" + tick + "] Server alive | Memory: " + (total - free) + "MB / " + total + "MB | TPS: 20.0");
                } catch (InterruptedException e) {
                    break;
                }
            }
        });
        ticker.setDaemon(true);
        ticker.start();

        // Stdin command listener
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = reader.readLine()) != null) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;

            System.out.println("[Server thread/INFO]: [Command] " + trimmed);

            if (trimmed.equalsIgnoreCase("stop")) {
                System.out.println("[Server thread/INFO]: Stopping the server");
                System.out.println("[Server thread/INFO]: Saving players");
                System.out.println("[Server thread/INFO]: Saving worlds");
                System.out.println("[Server thread/INFO]: Closing Thread Pool");
                ticker.interrupt();
                System.exit(0);
            } else if (trimmed.startsWith("say ")) {
                String msg = trimmed.substring(4);
                System.out.println("[Server thread/INFO]: [Server] " + msg);
            } else if (trimmed.equalsIgnoreCase("help")) {
                System.out.println("[Server thread/INFO]: Available QA commands: say <msg>, help, stop");
            }
        }
    }
}
`;

  const sourceFile = path.join(serverDir, 'ConsoleRunner.java');
  const classFile = path.join(serverDir, 'ConsoleRunner.class');
  const jarFile = path.join(serverDir, 'server.jar');

  fs.writeFileSync(sourceFile, javaSource, 'utf8');

  // Compile using installed javac
  try {
    execSync('javac ConsoleRunner.java', { cwd: serverDir, stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to compile Java source with javac: ${err.message}`);
  }

  // Package into executable jar with Main-Class manifest
  let packagedViaCli = false;
  try {
    execSync('jar cfe server.jar ConsoleRunner ConsoleRunner.class', { cwd: serverDir, stdio: 'pipe' });
    packagedViaCli = true;
  } catch {
    // Fallback: package with AdmZip if jar executable not in PATH
  }

  if (!packagedViaCli) {
    const zip = new AdmZip();
    zip.addLocalFile(classFile);
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: ConsoleRunner\r\n\r\n', 'utf8'));
    zip.writeZip(jarFile);
  }

  // Clean compile artifacts
  try { fs.unlinkSync(sourceFile); } catch {}
  try { fs.unlinkSync(classFile); } catch {}

  return jarFile;
}

function seedEditorFixture(serverDir) {
  const filePath = path.join(serverDir, 'large_config.properties');
  const lines = [
    '# ============================================================================== #',
    '# QA BROWSER VERIFICATION FIXTURE: 1500-LINE LARGE CONFIGURATION FILE            #',
    '# Generated for testing file manager opening, scrolling, editing, and saving.     #',
    '# ============================================================================== #'
  ];

  for (let i = 5; i <= 1500; i++) {
    lines.push(`mazipanel.qa.editor.benchmark.feature_key_${String(i).padStart(4, '0')}=setting_value_sample_token_${i}_alpha_beta_gamma`);
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function seedZipFixture(serverDir) {
  const fixturesDir = path.join(serverDir, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  const zip = new AdmZip();
  zip.addFile('world/level.dat', Buffer.from('MOCK_LEVEL_DAT_HEADER_SAMPLE', 'utf8'));
  zip.addFile('world/data/raids.dat', Buffer.from('MOCK_RAID_DATA_SAMPLE', 'utf8'));
  zip.addFile('plugins/sample_plugin.yml', Buffer.from('name: QAPlugin\nversion: 1.0.0\nmain: org.mazi.Test\n', 'utf8'));

  // Include 120 harmless distinct plugin config text entries in one folder for native archive paging and scrolling
  for (let i = 1; i <= 120; i++) {
    const idx = String(i).padStart(3, '0');
    const configContent = `# ==========================================================
# QA Paging Benchmark: Plugin Configuration Module ${idx}
# ==========================================================
module.id: plugin_config_${idx}
module.enabled: true
module.priority: ${i}
module.network.port: ${25500 + i}
module.threads.worker_pool: 4
module.cache.buffer_kb: 1024
module.features.async_telemetry: true
module.features.compression_level: 6
module.metadata.checksum: "qa_bench_${idx}_token"
`;
    zip.addFile(`plugins/configs/plugin_config_${idx}.yml`, Buffer.from(configContent, 'utf8'));
  }

  const zipPath = path.join(fixturesDir, 'qa_sample_world.zip');
  zip.writeZip(zipPath);
  return zipPath;
}

function seedEnergyStats(dataDir) {
  const energyPath = path.join(dataDir, 'energy-stats.json');
  const now = new Date();

  // Generate 36 realistic hourly buckets for the past 36 hours.
  // Last sample is previous hour (offset 1), not current hour to avoid duplicate with live sampler.
  const sampleStats = [];

  for (let offsetHours = 36; offsetHours >= 1; offsetHours--) {
    const bucketTime = new Date(now.getTime() - offsetHours * 3600 * 1000);
    const hStart = new Date(
      bucketTime.getFullYear(),
      bucketTime.getMonth(),
      bucketTime.getDate(),
      bucketTime.getHours(),
      0, 0, 0
    ).toISOString();

    const sampleCount = 360;
    const idleSamples = 120;
    const activeSamples = 240;

    // Simulate realistic profile: adjacent flat plateau at 45.2W (hours offset 8..5),
    // and realistic variance elsewhere
    let avgWatts = 45.2;
    let avgCpu = 15.4;
    let avgPlayers = 2;

    if (offsetHours >= 5 && offsetHours <= 8) {
      // Flat adjacent plateau to verify chart tooltip centering & interpolation
      avgWatts = 45.2;
      avgCpu = 15.0;
      avgPlayers = 2;
    } else if (offsetHours > 20) {
      // Nighttime lower activity
      avgWatts = 39.8;
      avgCpu = 8.2;
      avgPlayers = 0;
    } else if (offsetHours >= 10 && offsetHours <= 14) {
      // Peak gaming hours
      avgWatts = 56.4;
      avgCpu = 32.5;
      avgPlayers = 5;
    } else {
      // Moderate usage
      avgWatts = 47.1;
      avgCpu = 18.0;
      avgPlayers = 3;
    }

    const totalWattSum = Math.round(avgWatts * sampleCount * 10) / 10;
    const idleWattSum = Math.round((totalWattSum * (idleSamples / sampleCount) * 0.85) * 10) / 10;
    const activeWattSum = Math.round((totalWattSum - idleWattSum) * 10) / 10;

    sampleStats.push({
      start: hStart,
      sampleCount,
      avgWatts,
      avgCpu,
      avgPlayers,
      idleSamples,
      idleWattSum,
      activeSamples,
      activeWattSum
    });
  }

  fs.writeFileSync(energyPath, JSON.stringify(sampleStats, null, 2), 'utf8');
  return energyPath;
}

function setupQABrowserFixture() {
  // Separate fixture directory under QA_ROOT/servers/qa-real-java-20261011 (NOT QA_ROOT/server)
  const fixtureServerDir = path.join(qaServersDir, 'qa-real-java-20261011');
  fs.mkdirSync(fixtureServerDir, { recursive: true });

  // 1. Build real Java executable
  buildJavaConsoleJar(fixtureServerDir);

  // 2. server.properties (fallback maxPlayers = 10)
  const serverProps = [
    '# Minecraft server properties',
    '# QA Browser Verification Instance',
    'server-port=25575',
    'max-players=10',
    'motd=MaziPanel QA Real Java Fixture',
    'online-mode=false',
    'difficulty=easy',
    'pvp=true',
    'level-name=world'
  ].join('\n');
  fs.writeFileSync(path.join(fixtureServerDir, 'server.properties'), serverProps, 'utf8');

  // 3. Ensure valid 64x64 server-icon.png
  defaultIconHelper.ensureServerIcon(fixtureServerDir);

  // 4. Seed 1500-line editor file
  seedEditorFixture(fixtureServerDir);

  // 5. Seed sample zip archive
  seedZipFixture(fixtureServerDir);

  // 6. Seed energy stats into QA data directory with schema
  seedEnergyStats(qaDataDir);

  // 7. Detect current java runtime path
  const detectedJava = detectJavaPath();

  // 8. Register in serverRegistry with version 1.20.4, type purpur, memory 128-256MB, and graceful stop
  const fixtureServer = serverRegistry.register({
    id: 'qa-real-java-20261011',
    name: 'QA Real Java Console (1.20.4)',
    directory: fixtureServerDir,
    jarFile: 'server.jar',
    javaPath: detectedJava,
    type: 'purpur',
    version: '1.20.4',
    port: 25575,
    maxPlayers: 10,
    minRam: '128M',
    maxRam: '256M',
    ramAllocated: '256M',
    settings: {
      memory: {
        minMB: 128,
        maxMB: 256
      },
      startup: {
        jarFile: 'server.jar',
        javaPath: detectedJava,
        jvmFlags: '-Xms128M -Xmx256M',
        serverArgs: 'nogui'
      },
      stop: {
        command: 'stop',
        timeoutSec: 15,
        onTimeout: 'kill'
      },
      restart: {
        mode: 'graceful',
        delaySec: 2
      }
    }
  });

  console.log('\n============================================================');
  console.log('       MAZIPANEL QA BROWSER FIXTURE SETUP COMPLETE          ');
  console.log('============================================================');
  console.log(`Fixture Server ID   : ${fixtureServer.id}`);
  console.log(`Server Name         : ${fixtureServer.name}`);
  console.log(`Server Type/Version : ${fixtureServer.type} ${fixtureServer.version}`);
  console.log(`Server Directory    : ${fixtureServerDir}`);
  console.log(`QA Data Directory   : ${qaDataDir}`);
  console.log(`Port                : ${fixtureServer.port}`);
  console.log(`Max Players         : ${fixtureServer.maxPlayers}`);
  console.log(`Java Runtime Path   : ${detectedJava}`);
  console.log(`Allocated RAM       : 128M - 256M`);
  console.log(`Executable JAR      : ${path.join(fixtureServerDir, 'server.jar')}`);
  console.log(`Editor Fixture File : ${path.join(fixtureServerDir, 'large_config.properties')} (1500 lines)`);
  console.log(`ZIP Fixture File    : ${path.join(fixtureServerDir, 'fixtures', 'qa_sample_world.zip')}`);
  console.log(`Icon Status         : Valid 64x64 server-icon.png ensured`);
  console.log('------------------------------------------------------------');
  console.log('BROWSER VALIDATION INSTRUCTIONS FOR COORDINATOR:');
  console.log('1. Launch panel pointing to QA root configuration.');
  console.log('2. Select server "QA Real Java Console (1.20.4)".');
  console.log('3. Click "Başlat" (Start):');
  console.log('   - Notice 3-second startup delay (status "starting").');
  console.log('   - Once "Done (3.012s)! For help, type \\"help\\"" prints, status becomes "online".');
  console.log('   - Tick logs stream in console every 1 second.');
  console.log('4. Perform RAPID tab switching (Console <-> Files <-> Settings <-> System):');
  console.log('   - AnimatePresence mode="popLayout" switches immediately with ZERO blank waiting or black screen deadlock.');
  console.log('5. In "Dosyalar" (Files) tab, open "large_config.properties":');
  console.log('   - Confirms 1500 lines load and scroll smoothly in the editor.');
  console.log('6. In Console tab, send command: say hello world');
  console.log('   - Command echo prints immediately as "$ say hello world" before server reply.');
  console.log('7. Click "Durdur" (Stop):');
  console.log('   - Server gracefully receives "stop" and exits cleanly with exit code 0.');
  console.log('   - Console retains previous logs upon stop.');
  console.log('8. Click "Başlat" (Start) again:');
  console.log('   - Console lifecycle reset cleanly resets console log rows for new session.');
  console.log('============================================================\n');

  return fixtureServer;
}

if (require.main === module) {
  try {
    setupQABrowserFixture();
  } catch (err) {
    console.error('[ERROR] QA Fixture setup failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  setupQABrowserFixture,
  detectJavaPath,
  buildJavaConsoleJar,
  seedEditorFixture,
  seedZipFixture,
  seedEnergyStats
};
