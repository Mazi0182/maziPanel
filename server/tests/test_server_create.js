const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const authService = require('../src/auth/authService');

const BASE_URL = 'http://127.0.0.1:8080';
const WS_URL = 'ws://127.0.0.1:8080/ws';

async function main() {
  console.log('Testing Server Creation via POST /api/servers/create...');

  // Generate test auth token
  const token = authService.generateToken({ username: 'masteradmin', role: 'admin' });

  // 1. Setup WebSocket listener for download_progress
  const ws = new WebSocket(`${WS_URL}?token=${token}`);
  const progressEvents = [];

  await new Promise((resolve) => {
    ws.on('open', () => {
      console.log('WebSocket connected for download_progress monitoring');
      resolve();
    });
  });

  ws.on('error', (err) => console.error('WS ERROR:', err.message));
  ws.on('close', (code, reason) => console.log('WS CLOSED:', code, reason?.toString()));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'download_progress') {
        progressEvents.push(msg);
        console.log(`[Download Progress Event] ${msg.type} ${msg.version}: ${msg.percent}% (${msg.downloadedBytes}/${msg.totalBytes}) - ${msg.status}`);
      } else {
        console.log('[WS Other Event]:', msg.type);
      }
    } catch (e) {
      console.error('WS parse error:', e.message);
    }
  });

  // 2. Perform POST /api/servers/create
  const createPayload = JSON.stringify({
    name: 'Auto-Purpur-Test',
    type: 'purpur',
    version: '26.3',
    port: 25575,
    ramMin: '2G',
    ramMax: '4G'
  });

  console.log('\nSending POST /api/servers/create request...');
  const startTime = Date.now();

  const req = http.request(`${BASE_URL}/api/servers/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(createPayload),
      'Authorization': `Bearer ${token}`
    }
  });

  const response = await new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.write(createPayload);
    req.end();
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nCreation responded in ${duration}s with status ${response.status}`);
  console.log('Created server response:', JSON.stringify(response.data, null, 2));

  if (response.status !== 201 || !response.data || !response.data.id) {
    throw new Error(`Server creation failed: HTTP ${response.status}: ${JSON.stringify(response.data || response.raw)}`);
  }

  const server = response.data;
  const srvDir = server.directory;

  // 3. Verify files on disk
  console.log(`Checking files in ${srvDir}...`);
  if (!fs.existsSync(srvDir)) {
    throw new Error(`Server directory does not exist: ${srvDir}`);
  }

  const eulaFile = path.join(srvDir, 'eula.txt');
  if (!fs.existsSync(eulaFile)) {
    throw new Error('eula.txt does not exist!');
  }
  const eulaContent = fs.readFileSync(eulaFile, 'utf8');
  if (!eulaContent.includes('eula=true')) {
    throw new Error(`eula.txt content invalid: ${eulaContent}`);
  }
  console.log('eula.txt verified: eula=true');

  const propsFile = path.join(srvDir, 'server.properties');
  if (!fs.existsSync(propsFile)) {
    throw new Error('server.properties does not exist!');
  }
  const propsContent = fs.readFileSync(propsFile, 'utf8');
  if (!propsContent.includes(`server-port=${server.port}`)) {
    throw new Error(`server.properties missing server-port=${server.port}`);
  }
  console.log(`server.properties verified: port ${server.port}`);

  const jarFile = path.join(srvDir, 'server.jar');
  if (!fs.existsSync(jarFile)) {
    throw new Error('server.jar does not exist!');
  }
  const jarStat = fs.statSync(jarFile);
  console.log(`server.jar verified: size ${jarStat.size} bytes (${(jarStat.size / 1024 / 1024).toFixed(1)} MB)`);
  if (jarStat.size < 10 * 1024 * 1024) {
    throw new Error(`server.jar seems too small: ${jarStat.size} bytes`);
  }

  console.log(`\nWebSocket received ${progressEvents.length} download_progress events.`);
  if (progressEvents.length === 0) {
    console.warn('Warning: No download_progress events captured on WebSocket.');
  }

  // 4. Verify Auto Java selection respects documented requirements and detected installed runtime precedence
  console.log(`Checking Java runtime assigned: ${server.javaPath}...`);
  const javaCompatibility = require('../src/system/javaCompatibility');
  const javaDetector = require('../src/system/javaDetector');
  const javaReqs = javaCompatibility.getJavaRequirements(server.type || 'purpur', server.version || '26.3');
  const installed = javaDetector.detectJavaInstallations();
  const installedRec = installed.find((j) => j.majorVersion === javaReqs.recommendedJava);

  if (installedRec) {
    // Installed recommended Java (Java 25 for Purpur 26.3) must take precedence
    if (server.javaPath !== installedRec.path) {
      throw new Error(`Expected recommended Java ${javaReqs.recommendedJava} (${installedRec.path}), but got: ${server.javaPath}`);
    }
    console.log(`Verified recommended Java ${javaReqs.recommendedJava} (${server.javaPath}) chosen successfully.`);
  } else {
    // Otherwise, must choose a documented compatible alternative meeting minimum requirements (>= 25)
    const selectedInfo = javaDetector.inspectJavaExecutable(server.javaPath);
    const selectedMajor = selectedInfo?.majorVersion || (server.javaPath.match(/jdk-?(\d+)/i) ? parseInt(RegExp.$1, 10) : null);
    if (!selectedMajor || selectedMajor < javaReqs.minJava) {
      throw new Error(`Selected Java (${server.javaPath}) does not meet minimum Java ${javaReqs.minJava} for ${server.type || 'purpur'} ${server.version || '26.3'}`);
    }
    if (!javaCompatibility.isJavaCompatible(selectedMajor, server.type || 'purpur', server.version || '26.3')) {
      throw new Error(`Selected Java (${server.javaPath}, Java ${selectedMajor}) is incompatible with ${server.type || 'purpur'} ${server.version || '26.3'}`);
    }
    console.log(`Verified compatible alternative Java ${selectedMajor} (${server.javaPath}) chosen successfully.`);
  }

  // 5. Test File Manager listFiles, subfolder createFile, and delete
  const fileManager = require('../src/servers/fileManager');
  const filesList = fileManager.listFiles(server.id, '');
  console.log(`FileManager listFiles found ${filesList.entries.length} entries:`);
  for (const entry of filesList.entries) {
    console.log(`  - ${entry.isDirectory ? '[DIR]' : '[FILE]'} ${entry.name} (${entry.size} bytes)`);
  }

  // Verify creating a file in a non-existent subfolder works
  const subFileRes = fileManager.createFile(server.id, 'plugins/custom', 'plugin.yml', 'name: CustomPlugin\n');
  if (!subFileRes.success) {
    throw new Error('createFile with non-existent subfolder failed');
  }
  console.log('createFile with non-existent subfolder verified: plugins/custom/plugin.yml');

  // 5. Cleanup test server
  console.log(`Cleaning up test server ${server.id}...`);
  const serverRegistry = require('../src/servers/serverRegistry');
  serverRegistry.delete(server.id);
  if (fs.existsSync(srvDir)) {
    fs.rmSync(srvDir, { recursive: true, force: true });
  }
  console.log('Test server cleaned up successfully.');

  ws.close();
  console.log('\nAll Server Creation Tests PASSED successfully!');
}

main().catch((err) => {
  console.error('\nFatal Error in Server Creation Test:', err);
  process.exit(1);
});
